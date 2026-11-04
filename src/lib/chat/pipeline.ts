import type { ApiUser } from '@/lib/auth';
import { db } from '@/lib/db';

/**
 * Chat pipeline — port of open_webui/utils/middleware.py process_chat_payload /
 * process_chat_response (progressively enhanced: RAG, tools, memory, title/tags
 * tasks are wired in as the porting waves land).
 */

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  images?: string[];
  files?: any[];
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
};

export type ChatForm = {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  chat_id?: string;
  id?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number | null;
  presence_penalty?: number | null;
  frequency_penalty?: number | null;
  stop?: string | null;
  seed?: number | null;
  system?: string | null;
  features?: Record<string, any>;
  tool_ids?: string[] | null;
  files?: string[] | null;
  [key: string]: any;
};

export type ChatPayloadMetadata = {
  chat_id: string;
  message_id: string;
  session_id: string;
  tools?: any[];
  tool_ids?: string[];
  files?: any[];
  features?: Record<string, any>;
  variables?: Record<string, any>;
  [key: string]: any;
};

function uid(): string {
  return crypto.randomUUID();
}

/**
 * process_chat_payload — params/features normalization, RAG context injection,
 * tool installation. Phase 1: normalize + pass-through.
 */
export async function processChatPayload(
  user: ApiUser,
  form: ChatForm
): Promise<{ payload: ChatPayloadMetadata; payloads: ChatMessage[] }> {
  const chatId = form.chat_id ?? form.id ?? uid();
  const messageId = uid();

  const metadata: ChatPayloadMetadata = {
    chat_id: chatId,
    message_id: messageId,
    session_id: user.id,
    message_ids: [],
    tools: [],
    tool_ids: form.tool_ids ?? [],
    files: form.files ?? [],
    features: form.features ?? {},
    variables: {
      ...form.variables,
      '{{USER_NAME}}': user.name,
      '{{USER_LOCATION}}': '',
      '{{USER_DATE}}': new Date().toDateString(),
    },
  };

  // RAG context injection (files / knowledge attached to the message)
  try {
    const { ragInjectContext } = await import('@/lib/chat/rag');
    await ragInjectContext(user, form, metadata);
  } catch (e) {
    console.error('[pipeline] RAG injection skipped:', e);
  }

  // System prompt variables
  const messages = (form.messages ?? []).map((m) => {
    if (m.role === 'system' && typeof m.content === 'string') {
      let content = m.content;
      for (const [k, v] of Object.entries(metadata.variables ?? {})) {
        content = content.replaceAll(k, String(v ?? ''));
      }
      return { ...m, content };
    }
    return m;
  });

  return { payload: metadata, payloads: messages };
}

/**
 * generate_chat_completions — routes to the backend connection, streams the
 * response (SSE passthrough) and persists the finished messages.
 */
export async function generateChatCompletionInternal(
  user: ApiUser,
  form: ChatForm,
  metadata: ChatPayloadMetadata,
  messages: ChatMessage[]
): Promise<Response> {
  const { resolveModelRoute } = await import('@/lib/models-registry');
  const route = await resolveModelRoute(form.model);
  if (!route) {
    return new Response(JSON.stringify({ detail: 'No connection available for this model.' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Build the backend request body (OpenAI-compatible for both kinds)
  const body: Record<string, any> = {
    model: route.model,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.name ? { name: m.name } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    })),
    stream: form.stream ?? false,
  };
  for (const key of ['temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty', 'stop', 'seed'] as const) {
    const v = (form as any)[key];
    if (v !== undefined && v !== null) body[key] = v;
  }
  if (form.stream === false) delete body.stream;

  let url: string;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (route.type === 'openai') {
    url = `${route.baseUrl}/chat/completions`;
    if (route.apiKey) headers.authorization = `Bearer ${route.apiKey}`;
  } else {
    url = `${route.baseUrl}/api/chat`;
    body.stream = true; // ollama native always streams; aggregated below when form.stream=false
    body.options = {
      temperature: body.temperature,
      top_p: body.top_p,
      num_predict: body.max_tokens,
      presence_penalty: body.presence_penalty,
      frequency_penalty: body.frequency_penalty,
      stop: body.stop,
      seed: body.seed,
    };
    delete body.temperature;
    delete body.top_p;
    delete body.max_tokens;
    delete body.presence_penalty;
    delete body.frequency_penalty;
    delete body.stop;
    delete body.seed;
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    return new Response(
      JSON.stringify({
        detail: `Connection error to ${route.type} backend: ${e instanceof Error ? e.message : e}`,
      }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    );
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    return new Response(text || JSON.stringify({ detail: `Upstream error ${upstream.status}` }), {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Non-streaming
  if (route.type === 'openai' && !(form.stream ?? false)) {
    const data = await upstream.json();
    await persistIfChat(user, form, metadata, messages, [
      { role: 'assistant', content: data?.choices?.[0]?.message?.content ?? '' },
    ]);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Streaming: transform ollama NDJSON → OpenAI SSE when needed; pass-through otherwise
  const upstreamStream = route.type === 'openai' ? upstream.body : null;
  const wantsSse = true; // both paths emit SSE to the client

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let aggregateContent = '';

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));

      try {
        if (route.type === 'openai') {
          const reader = (upstreamStream as ReadableStream<Uint8Array>).getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            aggregateContent += extractDelta(text);
            send(text);
          }
        } else {
          // ollama NDJSON → OpenAI-compatible SSE
          const reader = upstream.body!.getReader();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, idx).trim();
              buffer = buffer.slice(idx + 1);
              if (!line) continue;
              try {
                const obj = JSON.parse(line);
                const content = obj.message?.content ?? '';
                aggregateContent += content;
                const sse = `data: ${JSON.stringify({
                  model: form.model,
                  created_at: obj.created_at ?? new Date().toISOString(),
                  object: 'chat.completion.chunk',
                  choices: [
                    {
                      index: 0,
                      delta: obj.done
                        ? {}
                        : { role: 'assistant', content },
                      finish_reason: obj.done ? 'stop' : null,
                    },
                  ],
                })}\n\n`;
                send(sse);
                if (obj.done) send('data: [DONE]\n\n');
              } catch {
                /* skip malformed line */
              }
            }
          }
          if (!aggregateContent.endsWith('[DONE]')) {
            // ensure termination for clients expecting it
          }
        }
        controller.close();
        // Persist after stream completes
        await persistIfChat(user, form, metadata, messages, [
          { role: 'assistant', content: aggregateContent },
        ]);
      } catch (e) {
        console.error('[pipeline] stream error', e);
        try {
          controller.error(e);
        } catch {
          /* already closed */
        }
      }
    },
  });

  void wantsSse;
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

function extractDelta(sseText: string): string {
  let out = '';
  for (const line of sseText.split('\n')) {
    if (line.startsWith('data:')) {
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const obj = JSON.parse(data);
        out += obj?.choices?.[0]?.delta?.content ?? '';
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

async function persistIfChat(
  user: ApiUser,
  form: ChatForm,
  metadata: ChatPayloadMetadata,
  messages: ChatMessage[],
  responseMessages: ChatMessage[]
): Promise<void> {
  const chatId = metadata.chat_id;
  if (!chatId) return;
  try {
    const chat = await db.chat.findFirst({ where: { id: chatId, user_id: user.id } });
    if (!chat) return;

    const history = chat.chat ? JSON.parse(chat.chat) : { messages: [] };
    const userMsg = messages[messages.length - 1];
    history.messages = [
      ...(history.messages ?? []),
      { role: 'user', content: userMsg?.content ?? '', ...pickFiles(userMsg) },
      ...responseMessages.map((m) => ({ role: m.role, content: m.content })),
    ];
    await db.chat.update({
      where: { id: chatId },
      data: { chat: JSON.stringify(history), updated_at: Math.floor(Date.now() / 1000) },
    });

    // ChatMessage rows (chat_message table, feature parity with Python).
    // Python stores epoch seconds (int(time.time())) — NOT nanoseconds.
    const lastTs = Math.floor(Date.now() / 1000);
    await db.chatMessage.createMany({
      data: [
        {
          id: crypto.randomUUID(),
          user_id: user.id,
          chat_id: chatId,
          role: 'user',
          content: userMsg?.content ?? '',
          created_at: lastTs,
          updated_at: lastTs,
        },
        ...responseMessages.map((m) => ({
          id: crypto.randomUUID(),
          user_id: user.id,
          chat_id: chatId,
          role: m.role,
          content: m.content ?? '',
          created_at: lastTs + 1,
          updated_at: lastTs + 1,
        })),
      ],
    });
  } catch (e) {
    console.error('[pipeline] persist failed', e);
  }
}

function pickFiles(m?: ChatMessage) {
  if (!m) return {};
  const out: Record<string, any> = {};
  if (m.files) out.files = m.files;
  if (m.images) out.images = m.images;
  return out;
}
