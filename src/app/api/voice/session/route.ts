export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest } from 'next/server';
import { buildCtx } from '@/server/http';
import { createVoiceSession } from '@/lib/voice/manager';
import { VOICES, voicesFor } from '@/lib/voice/voices';
import { VOICE_DEFAULT_LANGUAGE, VOICE_INTERRUPTION_ENABLED, voiceLlmEngine } from '@/lib/voice/config';

/** POST /api/voice/session — create a voice session. */
export async function POST(req: NextRequest) {
  try {
    const ctx = await buildCtx(req as unknown as Request, 'voice/session', {});
    if (!ctx.user) return Response.json({ detail: 'Not authenticated' }, { status: 401 });

    const body = await req.json().catch(() => ({})) as {
      language?: 'fr' | 'en';
      voice?: string;
      speed?: number;
      chatId?: string | null;
    };

    const session = await createVoiceSession(ctx.user, {
      language: body.language,
      voice: body.voice,
      speed: body.speed,
      chatId: body.chatId ?? null,
    });

    return Response.json({
      sessionId: session.id,
      language: session.language,
      voice: session.voice,
      speed: session.speed,
      chatId: session.chatId,
      providers: {
        llm: voiceLlmEngine(),
        tts: 'edge',
        stt: 'web-speech (@untemps/react-vocal, browser)',
      },
      config: {
        interruptionEnabled: VOICE_INTERRUPTION_ENABLED,
      },
    });
  } catch (e: any) {
    const status = typeof e?.status === 'number' ? e.status : 500;
    return Response.json({ detail: e?.message ?? 'session error' }, { status });
  }
}

/** GET /api/voice/session — catalogue + capabilities (no session). */
export async function GET() {
  return Response.json({
    languages: ['fr', 'en'],
    defaultLanguage: VOICE_DEFAULT_LANGUAGE,
    voices: voicesFor('edge'),
    allVoices: VOICES,
    providers: {
      llm: voiceLlmEngine(),
      tts: 'edge',
      stt: 'web-speech (@untemps/react-vocal, browser)',
    },
  });
}
