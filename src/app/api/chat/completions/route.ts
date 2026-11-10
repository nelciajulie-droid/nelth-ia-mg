export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Long-lived SSE stream. Video/photo generation turns run INSIDE this
// invocation (vibes ~35-60s+, nelthai ~15-40s, retries included) — the old
// 60s Hobby-era cap hard-killed the function mid-generation (truncated
// stream). The plan's ceiling is 300s (vercel.json) — take the full window
// so a generation is never interrupted by the platform.
export const maxDuration = 300;

import { NextRequest } from 'next/server';
import { buildCtx } from '@/server/http';
import { handleChatCompletions } from '@/server/root-handlers';

export async function POST(req: NextRequest) {
  // Diagnostics: intermittent pre-stream 500s (empty body) were undiagnosable
  // in serverless — the real exception now rides the JSON error response so
  // the client-side sanitizer surfaces it to the user (and the logs). Post-
  // stream errors keep their own transport (SSE error events).
  try {
    const ctx = await buildCtx(req as unknown as Request, 'chat/completions', {});
    return await handleChatCompletions(ctx);
  } catch (e) {
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error('[api/chat/completions] UNCAUGHT', e);
    return new Response(JSON.stringify({ detail: `[chat] ${detail}` }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}
