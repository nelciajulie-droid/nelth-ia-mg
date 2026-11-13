export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest } from 'next/server';
import { buildCtx } from '@/server/http';
import { getVoiceSession, ingestAudio } from '@/lib/voice/manager';

/**
 * POST /api/voice/audio?session=… — one PCM16 (16 kHz mono LE) chunk.
 * The browser posts ~every 100 ms while the voice session is live; events
 * (partials, finals, audio) stream back over the SSE channel.
 */
export async function POST(req: NextRequest) {
  const ctx = await buildCtx(req as unknown as Request, 'voice/audio', {});
  if (!ctx.user) return Response.json({ detail: 'Not authenticated' }, { status: 401 });

  const sessionId = req.nextUrl.searchParams.get('session') || '';
  const session = getVoiceSession(sessionId, ctx.user.id);
  if (!session) return Response.json({ detail: 'session not found' }, { status: 404 });

  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.length < 2) return Response.json({ detail: 'empty audio' }, { status: 400 });

  // Payload validation: cap per-post (400 KB ≈ 12 s of PCM) — the loop is
  // the browser's, garbage posts can never balloon the turn.
  if (raw.byteLength > 400_000) return Response.json({ detail: 'chunk too large' }, { status: 413 });

  await ingestAudio(session, raw);
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}
