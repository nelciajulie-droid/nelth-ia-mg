export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest } from 'next/server';
import { buildCtx } from '@/server/http';
import { getVoiceSession, startVoiceTurn } from '@/lib/voice/manager';

/**
 * POST /api/voice/turn?session=… — { text } — the browser's FINAL speech
 * transcript (@untemps/react-vocal, Web Speech API) enters the EXISTING
 * assistant pipeline: user message persisted → Kilo LLM streaming →
 * sentence-level Edge TTS chunks (all streamed back over SSE /api/voice/events).
 *
 * Interim transcripts are NEVER sent here — the browser keeps them
 * provisional until the engine emits a final result.
 */
export async function POST(req: NextRequest) {
  const ctx = await buildCtx(req as unknown as Request, 'voice/turn', {});
  if (!ctx.user) return Response.json({ detail: 'Not authenticated' }, { status: 401 });

  const sessionId = req.nextUrl.searchParams.get('session') || '';
  const session = getVoiceSession(sessionId, ctx.user.id);
  if (!session) return Response.json({ detail: 'session not found' }, { status: 404 });

  const body = await req.json().catch(() => ({})) as { text?: string };
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return Response.json({ detail: 'empty transcript' }, { status: 400 });
  if (text.length > 4000) return Response.json({ detail: 'transcript too long' }, { status: 413 });

  // Fire-and-forget: the turn streams over the SSE events channel; the turn
  // guard inside the manager rejects duplicate/parallel submissions.
  void startVoiceTurn(session, text).catch((e) => {
    console.error('[voice] assistant turn failed:', e);
    // The manager surfaces turn failures on the events channel.
  });
  return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}
