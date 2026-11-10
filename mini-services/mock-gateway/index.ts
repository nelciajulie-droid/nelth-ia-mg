/**
 * Mock OpenAI-compatible gateway — TEST HARNESS for « max tokens infinie ».
 *
 * Simulates a gateway whose output-token cap truncates the FIRST round
 * (finish_reason "length") and completes on the continuation round:
 *
 *   round 1 (fresh question)       → content "PART1-", finish_reason "length"
 *   round 2 (CONTINUE_INSTRUCTION) → content "PART2"/"CONT-", finish "stop"
 *
 * The round is detected from the request shape: a continuation request's
 * last message is the v12-flow CONTINUE_INSTRUCTION (role=user containing
 * "interrupted mid-output"), not the original question.
 *
 * Endpoints: POST /v1/chat/completions (SSE + JSON), GET /v1/models.
 * Port: 3999 (fixed — see project mini-services rules).
 */
const PORT = 3999;
const encoder = new TextEncoder();

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/v1/models') {
      return Response.json({ data: [{ id: 'echo-model', object: 'model', created: 1, owned_by: 'mock' }] });
    }

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const body: any = await req.json().catch(() => ({}));
      const msgs: any[] = Array.isArray(body?.messages) ? body.messages : [];
      const last = msgs[msgs.length - 1];
      const isContinue =
        last?.role === 'user' && /interrupted mid-output/i.test(String(last?.content ?? ''));

      console.log(
        `[mock-gateway] chat/completions stream=${body?.stream === true} round=${isContinue ? 2 : 1} messages=${msgs.length} max_tokens=${body?.max_tokens ?? 'absent'}`
      );

      if (body?.stream === true) {
        const chunks: string[] = isContinue ? ['CONT-'] : ['PART1-'];
        const finish: string = isContinue ? 'stop' : 'length';
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const text of chunks) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: 'mock',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: body?.model ?? 'echo-model',
                    choices: [{ index: 0, delta: { content: text } }],
                  })}\n\n`
                )
              );
            }
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: 'mock',
                  object: 'chat.completion.chunk',
                  created: 1,
                  model: body?.model ?? 'echo-model',
                  choices: [{ index: 0, delta: {}, finish_reason: finish }],
                })}\n\n`
              )
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }

      // Non-streaming: round 1 truncated by the cap, round 2 completes.
      return Response.json({
        id: 'mock',
        object: 'chat.completion',
        created: 1,
        model: body?.model ?? 'echo-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: isContinue ? 'PART2' : 'PART1-' },
            finish_reason: isContinue ? 'stop' : 'length',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
    }

    return new Response('not found', { status: 404 });
  },
});

console.log(`[mock-gateway] listening on http://localhost:${PORT}`);
