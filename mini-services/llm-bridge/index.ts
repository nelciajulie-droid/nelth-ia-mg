/**
 * LLM Bridge — OpenAI-compatible façade over z-ai-web-dev-sdk.
 *
 * Purpose: lets the Open WebUI port talk to a REAL model in the sandbox via
 * the standard OpenAI connection mechanism (OPENAI_API_BASE_URL=http://localhost:3030/v1).
 * On Vercel you configure a real OpenAI-compatible endpoint instead.
 *
 * Endpoints:
 *   GET  /v1/models
 *   POST /v1/chat/completions   (stream + non-stream, OpenAI shapes)
 */

import ZAI from 'z-ai-web-dev-sdk';

const PORT = 3030;
const MODEL_ID = 'z-ai-glm';

type ChatMessage = { role: string; content: string | null };

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/v1/models' && req.method === 'GET') {
      return Response.json(
        {
          object: 'list',
          data: [
            {
              id: MODEL_ID,
              object: 'model',
              created: Math.floor(Date.now() / 1000),
              owned_by: 'z-ai',
            },
          ],
        },
        { headers: cors }
      );
    }

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: { message: 'invalid JSON' } }, { status: 400, headers: cors });
      }
      const messages: ChatMessage[] = body?.messages ?? [];
      const wantsStream = body?.stream === true;

      let zai: InstanceType<typeof ZAI>;
      try {
        zai = await ZAI.create();
      } catch (e) {
        return Response.json(
          { error: { message: `bridge init failed: ${(e as Error).message}` } },
          { status: 503, headers: cors }
        );
      }

      const payload = {
        messages: messages
          .filter((m) => m.role !== 'tool')
          .map((m) => ({
            role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
          })),
        thinking: { type: 'disabled' },
      };

      try {
        const completion: any = await zai.chat.completions.create(payload);
        const content: string = completion?.choices?.[0]?.message?.content ?? '';
        const created = Math.floor(Date.now() / 1000);

        if (!wantsStream) {
          return Response.json(
            {
              id: completion?.id ?? `chatcmpl-${crypto.randomUUID()}`,
              object: 'chat.completion',
              created,
              model: MODEL_ID,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content },
                  finish_reason: 'stop',
                },
              ],
              usage: completion?.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            },
            { headers: cors }
          );
        }

        // Synthesize an OpenAI-compatible SSE stream from the complete text.
        const encoder = new TextEncoder();
        const chunkSize = 24;
        const chunks: string[] = [];
        for (let i = 0; i < content.length; i += chunkSize) {
          chunks.push(content.slice(i, i + chunkSize));
        }
        if (!chunks.length) chunks.push('');

        const id = `chatcmpl-${crypto.randomUUID()}`;
        const stream = new ReadableStream({
          async start(controller) {
            const send = (obj: unknown) =>
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
            for (const chunk of chunks) {
              send({
                id,
                object: 'chat.completion.chunk',
                created,
                model: MODEL_ID,
                choices: [{ index: 0, delta: { role: 'assistant', content: chunk }, finish_reason: null }],
              });
            }
            send({
              id,
              object: 'chat.completion.chunk',
              created,
              model: MODEL_ID,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            });
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            ...cors,
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          },
        });
      } catch (e) {
        return Response.json(
          { error: { message: `upstream error: ${(e as Error).message}` } },
          { status: 502, headers: cors }
        );
      }
    }

    return Response.json({ error: { message: 'Not Found' } }, { status: 404, headers: cors });
  },
});

console.log(`llm-bridge listening on :${PORT}`);
export {};
void server;
