/**
 * Voice API client — session + SSE + audio posts + interrupt + end.
 */

import type { VoiceEvent } from '@/lib/voice/protocol';

export type SessionInfo = {
  sessionId: string;
  language: string;
  voice: string;
  speed: number;
  chatId: string | null;
  providers: { llm: string; tts: string; stt: string };
  config: { sampleRate: number; pcm: string; chunkMs: number; vadSilenceMs: number; interruptionEnabled: boolean };
};

export type VoiceCatalogue = {
  languages: string[];
  defaultLanguage: string;
  voices: { id: string; label: string; language: 'fr' | 'en'; gender: string; provider: string }[];
  stt: { ok: boolean; runtime?: string; languages?: { key: string; model: string }[] };
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
    } catch { /* malformed frame dropped */ }
  };
  return { close: () => es.close() };
}

export async function postAudio(sessionId: string, pcm: Int16Array): Promise<void> {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  await fetch(`/api/voice/audio?session=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    body: new Blob([bytes as unknown as BlobPart]),
    credentials: 'same-origin',
    keepalive: false,
  }).catch(() => undefined); // transient network hiccups never break the session
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
