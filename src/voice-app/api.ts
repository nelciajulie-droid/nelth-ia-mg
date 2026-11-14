/**
 * Voice API client — session + SSE events + turn + interrupt + end.
 *
 * Speech recognition runs IN THE BROWSER (@untemps/react-vocal — Web
 * Speech API): microphone audio NEVER rides HTTP. The client sends only:
 *   • POST /api/voice/session   — create the session;
 *   • POST /api/voice/turn       — the FINAL transcript (never interim);
 *   • POST /api/voice/interrupt  — barge-in;
 *   • POST /api/voice/end        — leave;
 * and receives every assistant event (llm.token / tts.audio_chunk /
 * assistant.finished / errors) on the single SSE channel below.
 */

import type { VoiceEvent } from '@/lib/voice/protocol';

export type SessionInfo = {
  sessionId: string;
  language: string;
  voice: string;
  speed: number;
  chatId: string | null;
  providers: { llm: string; tts: string; stt: string };
  config: { interruptionEnabled: boolean };
};

export type VoiceCatalogue = {
  languages: string[];
  defaultLanguage: string;
  voices: { id: string; label: string; language: 'fr' | 'en'; gender: string; provider: string }[];
  stt: string;
};

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return data?.detail || data?.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function createSession(opts: { language?: string; voice?: string; speed?: number; chatId?: string | null }): Promise<SessionInfo> {
  const res = await fetch('/api/voice/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

export async function fetchCatalogue(): Promise<VoiceCatalogue> {
  const res = await fetch('/api/voice/voices', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

export function openEventStream(sessionId: string, onEvent: (ev: VoiceEvent) => void): { close: () => void } {
  const es = new EventSource(`/api/voice/events?session=${encodeURIComponent(sessionId)}`);
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data) as VoiceEvent);
    } catch {
      /* malformed frame dropped */
    }
  };
  return { close: () => es.close() };
}

/** Submit a FINAL transcript (never an interim) into the assistant pipeline. */
export async function postTurn(sessionId: string, text: string): Promise<void> {
  const res = await fetch(`/api/voice/turn?session=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(await readError(res));
}

export async function postInterrupt(sessionId: string): Promise<void> {
  await fetch(`/api/voice/interrupt?session=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    credentials: 'same-origin',
  }).catch(() => undefined);
}

export async function postEnd(sessionId: string): Promise<{ ok: boolean; chatId: string | null }> {
  const res = await fetch(`/api/voice/end?session=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!res.ok) return { ok: true, chatId: null };
  return res.json();
}
