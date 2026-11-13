/**
 * STT client — talks to the remote streaming STT service (sherpa-onnx host).
 * Server-to-server only; the browser never sees these endpoints.
 */

import { STT_REMOTE_URL, STT_AUTH_SECRET } from './config';

export type SttAudioResult = {
  partial: string;
  final?: string;
  vad: { speechActive: boolean; events: { type: string; t: number }[] };
};

export type SttSessionInfo = {
  id: string;
  language: string;
  chunkMs: number;
  sampleRate: number;
  silenceSec: number;
  maxSpeechSec: number;
};

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (STT_AUTH_SECRET) h['x-stt-secret'] = STT_AUTH_SECRET;
  return h;
}

export async function sttHealth(): Promise<{ ok: boolean; runtime?: string; languages?: { key: string; model: string }[] }> {
  try {
    const res = await fetch(`${STT_REMOTE_URL}/health`, { headers: headers(), signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { ok: false };
    return (await res.json()) as any;
  } catch {
    return { ok: false };
  }
}

export async function sttCreateSession(language: 'fr' | 'en', silenceMs: number): Promise<SttSessionInfo> {
  const res = await fetch(`${STT_REMOTE_URL}/v1/sessions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ language, silenceMs }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`STT session failed (${res.status}) ${detail.slice(0, 120)}`);
  }
  return (await res.json()) as SttSessionInfo;
}

/** Forward ONE PCM16 chunk; returns the turn-level updates. */
export async function sttFeedAudio(sttSessionId: string, pcm: Uint8Array): Promise<SttAudioResult> {
  const res = await fetch(`${STT_REMOTE_URL}/v1/sessions/${sttSessionId}/audio`, {
    method: 'POST',
    headers: STT_AUTH_SECRET ? { 'x-stt-secret': STT_AUTH_SECRET } : undefined,
    body: new Blob([pcm as unknown as BlobPart]),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`STT audio failed (${res.status})`);
  return (await res.json()) as SttAudioResult;
}

export async function sttFlush(sttSessionId: string): Promise<{ final: string }> {
  const res = await fetch(`${STT_REMOTE_URL}/v1/sessions/${sttSessionId}/flush`, {
    method: 'POST',
    headers: STT_AUTH_SECRET ? { 'x-stt-secret': STT_AUTH_SECRET } : undefined,
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`STT flush failed (${res.status})`);
  return (await res.json()) as { final: string };
}

/** Barge-in reset — drop the half-formed turn without emitting a final. */
export async function sttReset(sttSessionId: string): Promise<void> {
  try {
    await fetch(`${STT_REMOTE_URL}/v1/sessions/${sttSessionId}/reset`, {
      method: 'POST',
      headers: STT_AUTH_SECRET ? { 'x-stt-secret': STT_AUTH_SECRET } : undefined,
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    /* best effort */
  }
}

export async function sttDrop(sttSessionId: string): Promise<void> {
  try {
    await fetch(`${STT_REMOTE_URL}/v1/sessions/${sttSessionId}`, {
      method: 'DELETE',
      headers: STT_AUTH_SECRET ? { 'x-stt-secret': STT_AUTH_SECRET } : undefined,
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    /* best effort */
  }
}
