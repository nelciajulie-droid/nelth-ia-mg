/**
 * TokenHarbor gateway MOCK — local E2E testing only.
 *
 * The real gateway (https://tokenharbor.ai/v1) applies region-based access
 * control on the caller's egress IP, and the dev sandbox exits from a
 * blocked region — so the golden path (model listed → chat streams →
 * vision blocks arrive) is verified locally against THIS mock:
 *
 *   POST /v1/chat/completions
 *     • logs the exact wire request (model, thinking switch, message shapes,
 *       image_url blocks with data URLs)
 *     • stream:true → OpenAI SSE (`data: {choices:[{delta:{content}}]}` …
 *       `data: [DONE]`), exactly like the real gateway
 *     • stream:false → OpenAI JSON
 *     • when image blocks are present, the answer says so (vision proof)
 *
 * Port: 3031 (fixed).
 */

const PORT = 3031;

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type ChatMessage = { role: string; content: string | ContentPart[] };

function flattenForLog(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((p) => {
      if (p.type === 'text') return `text(${(p.text ?? '').length} chars)`;
      const url = p.image_url?.url ?? '';
      if (url.startsWith('data:')) return `image_url(data:${url.slice(5, 40)}…, ~${Math.round((url.length * 0.75) / 1024)} KB)`;
      return `image_url(${url.slice(0, 80)})`;
    })
    .join(' + ');
}

function buildAnswer(body: any): string {
  const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
  const images = messages.reduce((n, m) => {
    const c = m.content;
    return n + (Array.isArray(c) ? c.filter((p) => p && p.type === 'image_url').length : 0);
  }, 0);
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const lastText =
    typeof lastUser?.content === 'string'
      ? lastUser.content
      : Array.isArray(lastUser?.content)
        ? (lastUser.content as ContentPart[]).filter((p) => p.type === 'text').map((p) => p.text).join(' ')
        : '';
  const thinking = JSON.stringify(body?.thinking ?? null);
  console.log(
    [
      `[TokenHarbor-MOCK] model=${body?.model} thinking=${thinking} stream=${body?.stream === true} max_tokens=${body?.max_tokens}`,
      ...messages.map((m) => `  · ${m.role}: ${flattenForLog(m.content).slice(0, 120)}`),
      `[TokenHarbor-MOCK] vision blocks reçues : ${images}`,
    ].join('\n')
  );
  if (images > 0) {
    return (
      `Mock TokenHarbor — Nelth-4.0_Flash a bien reçu ta demande${lastText ? ` « ${lastText.slice(0, 60)} »` : ''}. ` +
      `J'analyse ${images} image(s) jointe(s) : ceci est une description simulée du contenu visuel (test vision E2E). ` +
      `Le thinking est désactivé (${thinking}) et je réponds en direct, token par token.`
    );
  }
  return (
    `Mock TokenHarbor — Nelth-4.0_Flash (deepseek-v4.1-flash) en ligne. ` +
    `Réponse en streaming direct, thinking désactivé (${thinking}). ` +
    `Ta demande : « ${lastText.slice(0, 80) || '(vide)'} ». Tout le pipeline SSE fonctionne.`
  );
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return Response.json({
        object: 'list',
        data: [{ id: 'deepseek-v4.1-flash:free', object: 'model', owned_by: 'tokenharbor' }],
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = await req.json().catch(() => ({}));
      const answer = buildAnswer(body);

      if (body?.stream === true) {
        const id = `chatcmpl-mock-${Date.now()}`;
        const encoder = new TextEncoder();
        const words = answer.split(' ');
        const stream = new ReadableStream({
          async start(controller) {
            const send = (obj: unknown) =>
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
            send({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
            for (let i = 0; i < words.length; i++) {
              await new Promise((r) => setTimeout(r, 25));
              send({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: (i === 0 ? '' : ' ') + words[i] }, finish_reason: null }] });
            }
            send({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        });
      }

      return Response.json({
        id: `chatcmpl-mock-${Date.now()}`,
        object: 'chat.completion',
        model: body?.model,
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
    }

    return Response.json({ error: { message: `no route: ${req.method} ${url.pathname}` } }, { status: 404 });
  },
});

console.log(`[tokenharbor-mock] listening on http://127.0.0.1:${PORT}/v1`);
