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
 *   thinkloop — SSE « thinking-only » reproduction (the stacked « Réflexion »
 *              screenshot): round 1 streams <thinking>-tag CONTENT only
 *              (no answer text) with finish_reason "length". A continuation
 *              round whose last user message carries the notes-convert
 *              instruction ("internal analysis notes") answers with plain
 *              content + stop. A CONTINUE_INSTRUCTION round ("interrupted
 *              mid-output") gets MORE thinking-only + length — reproducing
 *              the old re-think-from-scratch loop for regression testing.
 *   thinkstuck — pathological model: thinking-only on EVERY round, even the
 *              notes-convert round. Only the SALVAGE repair call ("notes,
 *              not an answer") gets the answer — exercises the server-side
 *              chain stop (streak ≥ 2) + notes-salvage path.
 *
 * Endpoint: POST /api/v1/chat/completions (JSON + SSE), GET /__log journal.
 * Port: 3100 (fixed — see project mini-services rules).
 */
const PORT = 3100;

type Mode = 'pass' | 'ctx' | 'notokens' | 'noflags' | 'thinkloop' | 'thinkstuck';
let mode: Mode = 'ctx';

interface Entry {
  t: number;
  max_tokens?: number;
  promptTokens: number;
  hasFlags: boolean;
  stream?: boolean;
  lastUserText?: string;
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
      const lastUser = [...msgs].reverse().find((m: any) => m?.role === 'user');
      const lastUserText = String(lastUser?.content ?? '');

      const entry: Entry = {
        t: Date.now(),
        max_tokens: maxTokens,
        promptTokens,
        hasFlags,
        ...(body?.stream === true ? { stream: true, lastUserText: lastUserText.slice(0, 80) } : {}),
      };
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

      // ---- thinkloop / thinkstuck: stacked « Réflexion » reproduction ----
      if (mode === 'thinkloop' || mode === 'thinkstuck') {
        const isConvertRound = /internal analysis notes/i.test(lastUserText);
        const isSalvageRound = /notes, not an answer/i.test(lastUserText);
        const wantsAnswer =
          mode === 'thinkloop' ? isConvertRound || isSalvageRound : isSalvageRound;
        const enc = new TextEncoder();
        const sse = (obj: any) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
        const chunk = (delta: any, model: string) =>
          sse({
            id: 'chatcmpl-thinkloop',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta }],
          });
        const finish = (reason: string, model: string) =>
          sse({
            id: 'chatcmpl-thinkloop',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: reason }],
          });
        const modelId = String(body?.model ?? 'unknown');
        console.log(
          `[atlas-mock] ${mode} round — convert=${isConvertRound} salvage=${isSalvageRound} answer=${wantsAnswer} stream=${body?.stream === true}`
        );
        // Non-streaming requests (the salvage repair call is stream:false)
        // get the plain JSON form; streaming rounds get the SSE form.
        if (body?.stream !== true) {
          const content = wantsAnswer
            ? `Les options, expliqué simplement : une option d'achat (call) vous donne le droit — pas l'obligation — d'acheter une action à un prix fixé d'avance avant une date limite. Vous payez une prime pour ce droit, comme une option de réservation.`
            : `<thinking>The user asks me to explain options trading in simple terms. Let me analyze: a call gives the right to buy at a strike price, a put the right to sell...</thinking>`;
          return Response.json({
            id: 'chatcmpl-atlas-mock',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: wantsAnswer ? 'stop' : 'length',
              },
            ],
            usage: { prompt_tokens: promptTokens, completion_tokens: 40, total_tokens: promptTokens + 40 },
          });
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            if (wantsAnswer) {
              // Notes given back → the model converts them into the answer.
              controller.enqueue(
                chunk({ content: `Les options, expliqué simplement : une option d'achat (call) vous donne le droit — pas l'obligation — d'acheter une action à un prix fixé d'avance avant une date limite. Vous payez une prime pour ce droit, comme une option de réservation.` }, modelId)
              );
              controller.enqueue(finish('stop', modelId));
            } else {
              // Round 1 or a blind CONTINUE round: thinking-only + length cap.
              controller.enqueue(
                chunk({ content: `<thinking>The user asks me to explain options trading in simple terms, given they know buying and selling stocks. Let me analyze: a call gives the right to buy at a strike price, a put the right to sell. I should structure this with an analogy to a deposit on a house purchase. Let me think about premiums, strike prices, expiration...` }, modelId)
              );
              controller.enqueue(finish('length', modelId));
            }
            controller.enqueue(enc.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }

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
