/**
 * AtlasCloud-style mock gateway — TEST HARNESS for the 400 self-healing ladder.
 *
 * Reproduces the production incident (2026-11-10, request_id 9cb66f0a):
 * a strict OpenAI-compatible provider (AtlasCloud serving
 * dots-studio/dots-3-note-preview:free) answers
 *   {"code":400,"msg":"bad request"}
 * with NO token keyword whenever prompt + max_tokens overflows its TOTAL
 * context window (512 000) — the text-sniffing ladder never fired on it.
 *
 * Modes (switchable at runtime via POST /__mode {"mode": "..."}):
 *   pass     — accept everything (baseline: pin stays at catalog max)
 *   ctx      — 400 when mockPromptTokens + max_tokens > 512 000.
 *              Mock counts tokens as chars/2.5 — STRICTER than the app's
 *              chars/3 estimate, so the clamp alone cannot always save the
 *              turn: the ladder must heal the rest (rung 1 → 32 768).
 *   notokens — 400 whenever max_tokens is present at all (rung 2 test:
 *              gateway default, no max_tokens).
 *   noflags  — 400 whenever a non-standard reasoning/thinking field is
 *              present (rung 3 test: flags stripped).
 *
 * Endpoint: POST /api/v1/chat/completions (JSON non-streaming — the test
 * drives stream:false). GET /__log returns the request journal.
 * Port: 3100 (fixed — see project mini-services rules).
 */
const PORT = 3100;

type Mode = 'pass' | 'ctx' | 'notokens' | 'noflags';
let mode: Mode = 'ctx';

interface Entry {
  t: number;
  max_tokens?: number;
  promptTokens: number;
  hasFlags: boolean;
  accepted?: boolean;
  rejected?: string;
}
const journal: Entry[] = [];

function countMockTokens(messages: any[]): number {
  let tokens = 0;
  for (const m of messages ?? []) {
    tokens += 8;
    const c = m?.content;
    if (typeof c === 'string') {
      tokens += Math.ceil(c.length / 2.5); // stricter than the app's /3
    } else if (Array.isArray(c)) {
      for (const p of c) {
        if (typeof p === 'string') tokens += Math.ceil(p.length / 2.5);
        else if (typeof p?.text === 'string') tokens += Math.ceil(p.text.length / 2.5);
        else tokens += 2_000;
      }
    }
  }
  return tokens;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/__mode' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      mode = (body?.mode as Mode) ?? 'ctx';
      journal.length = 0;
      console.log(`[atlas-mock] mode → ${mode}`);
      return Response.json({ ok: true, mode });
    }
    if (url.pathname === '/__log') {
      return Response.json({ mode, journal });
    }

    if (url.pathname === '/api/v1/chat/completions' && req.method === 'POST') {
      const body: any = await req.json().catch(() => ({}));
      const msgs: any[] = Array.isArray(body?.messages) ? body.messages : [];
      const promptTokens = countMockTokens(msgs);
      const maxTokens = typeof body?.max_tokens === 'number' ? body.max_tokens : undefined;
      const hasFlags =
        body?.reasoning !== undefined ||
        body?.include_reasoning !== undefined ||
        body?.thinking !== undefined;

      const entry: Entry = { t: Date.now(), max_tokens: maxTokens, promptTokens, hasFlags };
      journal.push(entry);

      const reject400 = (why: string) => {
        entry.rejected = why;
        console.log(
          `[atlas-mock] 400 (${why}) max_tokens=${maxTokens ?? 'absent'} promptTokens=${promptTokens} flags=${hasFlags}`
        );
        return Response.json(
          { code: 400, msg: 'bad request', request_id: crypto.randomUUID() },
          { status: 400 }
        );
      };

      if (mode === 'ctx' && maxTokens !== undefined && promptTokens + maxTokens > 512_000) {
        return reject400('ctx-overflow');
      }
      if (mode === 'notokens' && maxTokens !== undefined) {
        return reject400('any-max-tokens');
      }
      if (mode === 'noflags' && hasFlags) {
        return reject400('nonstandard-flags');
      }

      entry.accepted = true;
      console.log(
        `[atlas-mock] 200 max_tokens=${maxTokens ?? 'absent'} promptTokens=${promptTokens} flags=${hasFlags}`
      );
      return Response.json({
        id: 'chatcmpl-atlas-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body?.model ?? 'unknown',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: `[atlas-mock:${mode}] accepted max_tokens=${maxTokens ?? 'absent'} promptTokens=${promptTokens} flags=${hasFlags}`,
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: 14,
          total_tokens: promptTokens + 14,
        },
      });
    }

    return new Response('not found', { status: 404 });
  },
});

console.log(`[atlas-mock] listening on http://localhost:${PORT} (mode: ${mode})`);
