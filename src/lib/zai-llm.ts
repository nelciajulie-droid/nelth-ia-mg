/**
 * Built-in Z.AI SDK LLM engine (chat completions) — TS-port extension.
 *
 * Mirrors the src/lib/image-generation.ts pattern: a zero-config LLM backed
 * by z-ai-web-dev-sdk (server-side only) so chat completions work without
 * any external OpenAI/Ollama connection. The SDK speaks an OpenAI-compatible
 * wire format both for JSON responses and SSE streams (`choices[0].delta.
 * content` chunks), which lets the chat pipeline treat it as a synthetic
 * OpenAI upstream Response.
 *
 * Exposed as the built-in model `zai-glm-4-plus` in the model selector.
 */

import type { ApiUser } from '@/lib/auth';

export const ZAI_MODEL_ID = 'zai-glm-4-plus';
export const ZAI_MODEL_NAME = 'Z.AI GLM-4 Plus';
// No description: the main (empty chat) view shows a personalized greeting
// ("Bonjour/Bonsoir {name}, {phrase}") instead of a model blurb.
export const ZAI_MODEL_DESCRIPTION = '';

/** Second built-in model — same engine with reasoning (thinking) enabled. */
export const ZAI_REASONING_MODEL_ID = 'zai-glm-reasoning';
export const ZAI_REASONING_MODEL_NAME = 'Z.AI GLM Reasoning';
export const ZAI_REASONING_MODEL_DESCRIPTION =
  'Modèle Z.AI avec raisonnement approfondi (thinking) — idéal pour les problèmes complexes.';

/** All model ids owned by this engine (chat selector routing). */
export function isZaiSdkModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  return modelId === ZAI_MODEL_ID || modelId === ZAI_REASONING_MODEL_ID || modelId.startsWith('zai-sdk.');
}

/** Reasoning model flag — drives `thinking: enabled` for the SDK call. */
export function zaiModelWantsThinking(modelId: string | null | undefined): boolean {
  return modelId === ZAI_REASONING_MODEL_ID || modelId?.startsWith('zai-sdk.reasoning') === true;
}

export type ZaiChatParams = {
  messages: { role: string; content: string }[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  thinking?: 'enabled' | 'disabled';
};

let zaiPromise: Promise<any> | null = null;
async function getZai(): Promise<any> {
  zaiPromise ??= (async () => {
    const ZAI = (await import('z-ai-web-dev-sdk')).default;
    return ZAI.create();
  })();
  return zaiPromise;
}

/** Normalize params for the SDK body (it ignores unknown OpenAI fields, but
 *  we keep the body minimal + deterministic). */
function buildBody(params: ZaiChatParams): Record<string, any> {
  const body: Record<string, any> = {
    messages: params.messages.map((m) => ({
      role: m.role === 'system' || m.role === 'user' || m.role === 'assistant' ? m.role : 'user',
      content: m.content,
    })),
    stream: params.stream === true,
    thinking: { type: params.thinking ?? 'disabled' },
  };
  if (typeof params.temperature === 'number') body.temperature = params.temperature;
  if (typeof params.top_p === 'number') body.top_p = params.top_p;
  if (typeof params.max_tokens === 'number' && params.max_tokens > 0) {
    // SDK hard ceiling: it rejects max_tokens above 98 304
    // ("max_tokens参数非法：限制数值范围[1,98304]") — clamp here so the
    // generous no-ceiling defaults of the chat pipeline (65 536 / 131 072
    // per gateway model) stay valid on this local engine too. Values below
    // the ceiling pass through untouched.
    body.max_tokens = Math.min(params.max_tokens, 98_304);
  }
  return body;
}

/** Non-streaming chat completion → OpenAI-compatible JSON object. */
export async function zaiChatCompletion(params: ZaiChatParams): Promise<any> {
  const zai = await getZai();
  return zai.chat.completions.create(buildBody({ ...params, stream: false }));
}

/** Streaming chat completion → SSE ReadableStream (OpenAI chunk shape). */
export async function zaiChatCompletionStream(params: ZaiChatParams): Promise<ReadableStream<Uint8Array>> {
  const zai = await getZai();
  const stream = await zai.chat.completions.create(buildBody({ ...params, stream: true }));
  return stream as ReadableStream<Uint8Array>;
}

/**
 * Synthesize an OpenAI-compatible upstream `Response` for the chat pipeline
 * (v12-flow) — JSON when non-streaming, `text/event-stream` when streaming.
 * The pipeline then handles persistence / socket events / SSE passthrough
 * exactly like a regular OpenAI connection.
 */
export async function zaiUpstreamResponse(params: ZaiChatParams): Promise<Response> {
  if (params.stream === true) {
    const body = await zaiChatCompletionStream(params);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
    });
  }
  const data = await zaiChatCompletion(params);
  return new Response(JSON.stringify(data ?? {}), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Title generation helper (tasks.py generate_title equivalent for Z.AI). */
export async function zaiGenerateTitle(prompt: string): Promise<string | null> {
  try {
    const data: any = await zaiChatCompletion({
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      max_tokens: 200,
    });
    const content: string = data?.choices?.[0]?.message?.content ?? '';
    if (!content) return null;
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(content.slice(start, end + 1));
        if (parsed?.title) return String(parsed.title);
      } catch {
        /* fall through */
      }
    }
    return null;
  } catch {
    return null;
  }
}
