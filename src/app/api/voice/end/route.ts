export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest } from 'next/server';
import { buildCtx } from '@/server/http';
import { getVoiceSession, endVoiceSession } from '@/lib/voice/manager';

/** POST /api/voice/end?session=… — flush + cleanup (mic released client-side). */
export async function POST(req: NextRequest) {
  const ctx = await buildCtx(req as unknown as Request, 'voice/end', {});
  if (!ctx.user) return Response.json({ detail: 'Not authenticated' }, { status: 401 });

  const sessionId = req.nextUrl.searchParams.get('session') || '';
  const session = getVoiceSession(sessionId, ctx.user.id);
  if (!session) return Response.json({ detail: 'session not found' }, { status: 404 });

  await endVoiceSession(sessionId, 'client');
  return Response.json({ ok: true, chatId: session.chatId });
}
