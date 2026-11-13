export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest } from 'next/server';
import { buildCtx } from '@/server/http';
import { getVoiceSession, interruptAssistant } from '@/lib/voice/manager';

/** POST /api/voice/interrupt?session=… — barge-in: stop speaking NOW. */
export async function POST(req: NextRequest) {
  const ctx = await buildCtx(req as unknown as Request, 'voice/interrupt', {});
  if (!ctx.user) return Response.json({ detail: 'Not authenticated' }, { status: 401 });

  const sessionId = req.nextUrl.searchParams.get('session') || '';
  const session = getVoiceSession(sessionId, ctx.user.id);
  if (!session) return Response.json({ detail: 'session not found' }, { status: 404 });

  await interruptAssistant(session, 'user');
  return new Response(null, { status: 204 });
}
