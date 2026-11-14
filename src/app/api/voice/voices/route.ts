export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest } from 'next/server';
import { buildCtx } from '@/server/http';
import { voicesFor } from '@/lib/voice/voices';
import { VOICE_DEFAULT_LANGUAGE } from '@/lib/voice/config';

/** GET /api/voice/voices — catalogue + live capabilities for the UI.
 *  STT is client-side (Web Speech API via @untemps/react-vocal) — the
 *  browser reports its own support; no server health to probe. */
export async function GET(req: NextRequest) {
  const ctx = await buildCtx(req as unknown as Request, 'voice/voices', {});
  if (!ctx.user) return Response.json({ detail: 'Not authenticated' }, { status: 401 });
  return Response.json({
    languages: ['fr', 'en'],
    defaultLanguage: VOICE_DEFAULT_LANGUAGE,
    voices: voicesFor('edge'),
    stt: 'web-speech (@untemps/react-vocal, browser)',
  });
}
