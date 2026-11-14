export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest } from 'next/server';
import { buildCtx } from '@/server/http';
import { voicesFor } from '@/lib/voice/voices';
import { VOICE_DEFAULT_LANGUAGE } from '@/lib/voice/config';
import { sttHealth } from '@/lib/voice/stt-client';

/** GET /api/voice/voices — catalogue + live capabilities for the UI. */
export async function GET(req: NextRequest) {
  const ctx = await buildCtx(req as unknown as Request, 'voice/voices', {});
  if (!ctx.user) return Response.json({ detail: 'Not authenticated' }, { status: 401 });
  const stt = await sttHealth();
  return Response.json({
    languages: ['fr', 'en'],
    defaultLanguage: VOICE_DEFAULT_LANGUAGE,
    voices: voicesFor('edge'),
    stt: { ok: stt.ok, runtime: stt.runtime, languages: stt.languages },
  });
}
