/**
 * Voice API client — session + transports + interrupt + end.
 *
 * TWO transports, one protocol:
 *   1. WebSocket (preferred) — /api/voice/ws carries audio uplink AND the
 *      event downlink in one bidirectional connection (Vercel WS Public
 *      Beta — Fluid Compute). Tried first with a short timeout.
 *   2. HTTP + SSE (fallback, the originally tested pipeline) — POST
 *      /api/voice/audio + GET /api/voice/events. Used whenever the WS
 *      upgrade is unavailable (e.g. local dev runtime returns 501) or the
 *      socket drops mid-session.
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

// ---------------------------------------------------------------------------
// WebSocket transport (preferred) — bidirectional audio + events.
// ---------------------------------------------------------------------------

export type VoiceSocket = {
  sendAudio: (pcm: Int16Array) => void;
  sendInterrupt: () => void;
  sendEnd: () => void;
  close: () => void;
};

/** Await the bidirectional socket; resolves to null when the upgrade fails
 *  or never completes (dev runtime answers 501) → the caller keeps the
 *  HTTP+SSE pipeline (openEventStream + postAudio). Mid-session drops
 *  downgrade via onDowngrade. */
export async function openVoiceSocket(
  sessionId: string,
  onEvent: (ev: VoiceEvent) => void,
  onDowngrade?: (reason: string) => void,
  timeoutMs = 3500
): Promise<VoiceSocket | null> {
  if (typeof WebSocket === 'undefined') return null;
  let ws: WebSocket;
  try {
    ws = new WebSocket(`/api/voice/ws?session=${encodeURIComponent(sessionId)}`);
  } catch {
    return null;
  }
  const pending: string[] = [];

  const ready = new Promise<boolean>((resolve) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* noop */ }
      resolve(false);
    };
    ws.onmessage = (m) => {
      try {
        const ev = JSON.parse(String(m.data)) as VoiceEvent;
        if (ev && (ev as any).type === 'ws.ready') {
          if (settled) { onEvent(ev); return; }
          settled = true;
          while (pending.length) {
            const frame = pending.shift()!;
            try { ws.send(frame); } catch { /* closing */ }
          }
          resolve(true);
          return;
        }
        onEvent(ev);
      } catch { /* malformed frame dropped */ }
    };
    ws.onerror = fail;
    ws.onclose = () => {
      if (settled) { onDowngrade?.('ws-closed'); return; } // mid-session drop
      fail(); // never established → SSE fallback
    };
    setTimeout(fail, timeoutMs);
  });

  const ok = await ready;
  if (!ok) return null;

  const queueOrSend = (frame: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(frame); return; } catch { /* closing */ }
    }
    if (pending.length < 64) pending.push(frame); // bounded buffer (reconnect edge)
  };

  return {
    sendAudio: (pcm: Int16Array) => {
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      // btoa over chunked string conversion (robust for large arrays).
      let bin = '';
      const step = 0x8000;
      for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)) as unknown as number[]);
      queueOrSend(JSON.stringify({ type: 'audio', pcm: btoa(bin) }));
    },
    sendInterrupt: () => queueOrSend(JSON.stringify({ type: 'interrupt' })),
    sendEnd: () => queueOrSend(JSON.stringify({ type: 'end' })),
    close: () => {
      try { ws.close(); } catch { /* already closed */ }
    },
  };
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
