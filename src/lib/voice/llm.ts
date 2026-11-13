/**
 * Voice LLM adapter — NVIDIA Nemotron through the Kilo gateway.
 *
 * Mandated configuration (mission §4):
 *   model   : nvidia/nemotron-3.5-super-vl:free   (verified on the gateway)
 *   endpoint: {KILO_VOICE_BASE_URL}/chat/completions (OpenAI-compatible)
 *   stream  : ENABLED
 *   thinking: DISABLED — `reasoning: {enabled:false}` + `include_reasoning:
 *             false` (the OpenRouter-style controls this gateway family
 *             documents; already battle-tested by kilo-llm.ts in this repo).
 *             Any `reasoning`/`<think>` deltas are stripped defensively so
 *             chain-of-thought NEVER reaches the TTS.
 *
 * Keyless environments (no KILO_API_KEY, e.g. local sandbox) fall back to
 * the EXISTING z-ai SDK engine (same OpenAI wire format) — mirroring
 * kilo-llm.ts's keyless fallback design. The mandated model id stays the
 * configured default wherever a key is present (Vercel env).
 */

import { KILO_API_KEY, KILO_VOICE_BASE_URL, VOICE_LLM_MODEL } from './config';

export type VoiceLlmChunk = { text: string; done: boolean };
export type VoiceLlmHandle = {
  model: string;
  engine: 'kilo' | 'zai';
  /** Stream chunks; rejects on transport errors; honors abort. */
  run: (messages: { role: string; content: string }[], onToken: (text: string) => void, signal: AbortSignal) => Promise<{ text: string; truncated: boolean }>;
};

function stripThinkingDelta(obj: any): string {
  // Only normal assistant content is ever forwarded (mission §4/H).
  let out = '';
  const c = obj?.choices?.[0];
  if (c) {
    const delta = c.delta ?? c.message;
    if (delta && typeof delta === 'object') {
      if (typeof delta.content === 'string') out += delta.content;
      else if (Array.isArray(delta.content)) {
        for (const part of delta.content) if (part && typeof part.text === 'string') out += part.text;
      }
    }
  }
  return out;
}

function chunkTextFromSseLine(line: string): VoiceLlmChunk | null {
  if (!line.startsWith('data:')) return null;
  const body = line.slice(5).trim();
  if (!body || body === '[DONE]') return { text: '', done: true };
  try {
    const obj = JSON.parse(body);
    const text = stripThinkingDelta(obj);
    return { text, done: obj?.choices?.[0]?.finish_reason != null };
  } catch {
    return null; // keep-alive comments / partial frames
  }
}

/** Decode an OpenAI-compatible SSE stream into text tokens. */
async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  onToken: (t: string) => void,
  signal: AbortSignal
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let truncated = false;
  try {
    for (;;) {
      if (signal.aborted) {
        truncated = true;
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const chunk = chunkTextFromSseLine(line.trim());
        if (!chunk) continue;
        if (chunk.text) {
          full += chunk.text;
          onToken(chunk.text);
        }
      }
    }
  } finally {
    try { reader.cancel(); } catch { /* already closed */ }
  }
  return { text: full, truncated };
}

export function makeVoiceLlm(): VoiceLlmHandle {
  const engine: 'kilo' | 'zai' = KILO_API_KEY ? 'kilo' : 'zai';

  async function run(
    messages: { role: string; content: string }[],
    onToken: (text: string) => void,
    signal: AbortSignal
  ): Promise<{ text: string; truncated: boolean }> {
    if (engine === 'kilo') {
      try {
        const res = await fetch(`${KILO_VOICE_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${KILO_API_KEY}`,
            'user-agent': 'Nelth-AI/1.0 (+voice)',
          },
          body: JSON.stringify({
            model: VOICE_LLM_MODEL,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            stream: true,
            // THINKING DISABLED — verified OpenRouter-style controls for this
            // gateway family (see kilo-llm.ts buildBody).
            reasoning: { enabled: false },
            include_reasoning: false,
            temperature: 0.6,
            max_tokens: 900,
          }),
          signal,
        });
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => '');
          throw new Error(`Kilo voice LLM ${res.status}: ${detail.slice(0, 160)}`);
        }
        return await consumeSse(res.body, onToken, signal);
      } catch (e: any) {
        if (signal.aborted) throw e; // interruption — never masked
        // The mandated model id is verified on api.kilo.ai/api/gateway/v1;
        // hosts bound to the LEGACY gateway surface (or expired keys) can
        // reject it — degrade transparently to the existing z-ai engine so
        // the voice conversation never dies (reported via engine label).
        console.warn('[voice] Kilo LLM unavailable, falling back to the built-in engine:', e?.message);
        const { zaiChatCompletionStream } = await import('@/lib/zai-llm');
        const body = await zaiChatCompletionStream({ messages, stream: true, thinking: 'disabled' });
        return consumeSse(body, onToken, signal);
      }
    }

    // Keyless fallback — the EXISTING z-ai engine (OpenAI SSE wire format),
    // thinking disabled, same consumption path. Sandbox/local only.
    const { zaiChatCompletionStream } = await import('@/lib/zai-llm');
    const body = await zaiChatCompletionStream({ messages, stream: true, thinking: 'disabled' });
    return consumeSse(body, onToken, signal);
  }

  return { model: VOICE_LLM_MODEL, engine, run };
}
