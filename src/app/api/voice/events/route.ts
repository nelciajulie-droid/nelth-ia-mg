export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest } from 'next/server';
import { buildCtx } from '@/server/http';
import { getVoiceSession, subscribe } from '@/lib/voice/manager';
import type { VoiceEvent } from '@/lib/voice/protocol';

/**
 * GET /api/voice/events?session=… — the server→client event channel (SSE).
 * Every event (vad / stt.partial / stt.final / llm.token / tts.audio_chunk /
 * assistant.finished / errors) rides this single stream.
 */
export async function GET(req: NextRequest) {
  const ctx = await buildCtx(req as unknown as Request, 'voice/events', {});
  if (!ctx.user) return Response.json({ detail: 'Not authenticated' }, { status: 401 });

  const sessionId = req.nextUrl.searchParams.get('session') || '';
  const session = getVoiceSession(sessionId, ctx.user.id);
  if (!session) return Response.json({ detail: 'session not found' }, { status: 404 });

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: VoiceEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* stream closed */
        }
      };
      // Replay-anchors: fresh subscribers start from the live stream (the
      // UI re-syncs its transcript from stt.partial snapshots anyway).
      send({ type: 'session.ready', sessionId: session.id, ts: Date.now(), payload: { language: session.language, voice: session.voice, sttModel: '', llmModel: '', ttsProvider: '', chatId: session.chatId } } as VoiceEvent);
      unsubscribe = subscribe(session, send);
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          /* closed */
        }
      }, 15_000);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
