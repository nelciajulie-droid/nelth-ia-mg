export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextRequest } from 'next/server';
import { upgradeWebSocket } from '@vercel/functions';
import type { WebSocket } from 'ws';
import { buildCtx } from '@/server/http';
import { getVoiceSession, ingestAudio, interruptAssistant, endVoiceSession, subscribe } from '@/lib/voice/manager';
import type { VoiceEvent } from '@/lib/voice/protocol';

/**
 * GET /api/voice/ws?session=… — BIDIRECTIONAL WebSocket transport for the
 * voice session (Vercel Functions WebSocket, Public Beta since 2026-06-22,
 * Fluid Compute, Active CPU pricing).
 *
 * Same session state machine as the HTTP+SSE endpoints — this route is an
 * ALTERNATE transport, not a second pipeline:
 *   uplink   {type:'audio', pcm:<base64 PCM16 16k>} | {type:'interrupt'} | {type:'end'}
 *   downlink  every VoiceEvent as JSON (identical to the SSE payloads).
 *
 * Local/dev runtimes that lack the Vercel WS bridge get a clean 501 — the
 * client then falls back to the TESTED HTTP-audio + SSE-events channel
 * (see src/voice-app/api.ts openVoiceSocket).
 */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('session') || '';

  // Auth + session resolution on the UPGRADE request itself (cookies ride
  // the initial HTTP GET) — never upgrade an unauthenticated connection.
  const ctx = await buildCtx(req as unknown as Request, 'voice/ws', {});
  if (!ctx.user) return Response.json({ detail: 'Not authenticated' }, { status: 401 });
  const session = getVoiceSession(sessionId, ctx.user.id);
  if (!session) return Response.json({ detail: 'session not found' }, { status: 404 });

  try {
    return await upgradeWebSocket((ws: WebSocket) => {
      const send = (payload: unknown) => {
        try { ws.send(JSON.stringify(payload)); } catch { /* closing */ }
      };

      // Downlink: every VoiceEvent (same wire format as the SSE channel).
      const unsubscribe = subscribe(session, (event: VoiceEvent) => send(event));
      send({ type: 'ws.ready', sessionId: session.id, ts: Date.now(), payload: { transport: 'websocket' } });

      // Uplink messages.
      ws.on('message', async (data: unknown) => {
        let msg: { type: string; pcm?: string };
        try {
          msg = JSON.parse(String(data));
        } catch {
          return; // ignore malformed frames
        }
        switch (msg.type) {
          case 'audio': {
            const b64 = String(msg.pcm || '');
            if (!b64) return;
            // Same per-chunk cap as the HTTP route (400 KB ≈ 12 s of PCM).
            if ((b64.length * 3) / 4 > 400_000) return;
            try {
              const pcm = new Uint8Array(Buffer.from(b64, 'base64'));
              await ingestAudio(session, pcm);
            } catch {
              send({ type: 'session.error', sessionId: session.id, ts: Date.now(), payload: { stage: 'ws', message: 'chunk rejected', recoverable: true } });
            }
            break;
          }
          case 'interrupt': {
            await interruptAssistant(session, 'user').catch(() => undefined);
            break;
          }
          case 'end': {
            await endVoiceSession(session.id, 'ws-client').catch(() => undefined);
            break;
          }
        }
      });

      ws.on('close', () => {
        unsubscribe();
        // Closing the socket WITHOUT 'end' still releases server resources
        // (idle GC also sweeps, same as the SSE channel).
        void endVoiceSession(session.id, 'ws-close').catch(() => undefined);
      });
    });
  } catch {
    // Runtime without the Vercel WS bridge (e.g. local next dev) — the
    // client uses the HTTP+SSE transport instead.
    return Response.json({ detail: 'websocket transport unavailable — fallback: HTTP+SSE', transport: 'sse' }, { status: 501 });
  }
}
