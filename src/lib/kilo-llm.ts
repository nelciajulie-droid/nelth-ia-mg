/**
 * Built-in Kilo AI Gateway LLM engine (chat completions) — TS-port extension.
 *
 * Two free models are exposed through the OpenAI-compatible Kilo AI Gateway
 * (https://ai-gateway.kilo.ai/api/v1 — auth: `Bearer KILO_GATEWAY_API_KEY`):
 *
 *   1. dots-studio/dots-3-note-preview:free  — standard chat model
 *      (Dots Studio MoE, 280B total / 16B active)
 *   2. nvidia/nemotron-3-ultra-550b-a55b:free — reasoning (thinking) model
 *      (NVIDIA MoE, 550B total / 55B active)
 *
 * The gateway speaks an OpenAI-compatible wire format for both JSON
 * responses and SSE streams (`choices[0].delta.content` chunks). Native
 * reasoning arrives in dedicated `delta.reasoning` / `message.reasoning`
 * fields — the chat pipeline (v12-flow) converts them into the structured
 * Open WebUI v0.12.5 `output` items that the compiled frontend renders as
 * the collapsible "Thinking… / Thought for N seconds" block.
 *
 * NO fallback provider: without KILO_GATEWAY_API_KEY the engine is simply
 * unavailable (`kiloAvailable()` → false, models unlisted, completions
 * 404) — the app NEVER silently routes to another provider.
 */

/** Kilo AI Gateway base URL (OpenAI-compatible routes under /api/v1). */
export const KILO_GATEWAY_BASE_URL =
  process.env.KILO_GATEWAY_BASE_URL || 'https://ai-gateway.kilo.ai/api/v1';

/** Gateway API key (kilo.ai → Settings → API Keys, JWT with kiloUserId). */
export const KILO_GATEWAY_API_KEY = process.env.KILO_GATEWAY_API_KEY || '';

/**
 * True when the built-in models can be served — the Kilo gateway key MUST
 * be configured. There is NO keyless fallback: without a key the models are
 * unlisted and completions return a configuration error (never another
 * provider).
 */
export function kiloAvailable(): boolean {
  return KILO_GATEWAY_API_KEY.length > 0;
}

/** Built-in standard chat model — Kilo gateway Dots3-Note Preview, shown as "Nelth-3.5". */
export const KILO_MODEL_ID = 'dots-studio/dots-3-note-preview:free';
export const KILO_MODEL_NAME = 'Nelth-3.5';
// No description: the main (empty chat) view shows a personalized greeting
// ("Bonjour/Bonsoir {name}, {phrase}") instead of a model blurb.
export const KILO_MODEL_DESCRIPTION = '';

/** Built-in reasoning (thinking) model — Kilo gateway Nemotron 3 Ultra, shown as "Nelth-3.5_Thinking". */
export const KILO_REASONING_MODEL_ID = 'nvidia/nemotron-3-ultra-550b-a55b:free';
export const KILO_REASONING_MODEL_NAME = 'Nelth-3.5_Thinking';
export const KILO_REASONING_MODEL_DESCRIPTION = '';

/**
 * Legacy GLM model ids (removed engine) → Kilo gateway equivalents, so chats
 * created with the old built-in models keep working on the new ones.
 */: Record<string, string> = {
  'zai-glm-4-plus': KILO_MODEL_ID,
  'zai-glm-reasoning': KILO_REASONING_MODEL_ID,
};

/** Map a legacy GLM id to its Kilo replacement (identity otherwise). */
export function normalizeKiloModelId(modelId: string | null | undefined): string {
  if (!modelId) return modelId as any;
  return LEGACY_MODEL_MAP[modelId] ?? modelId;
}

/** All model ids owned by this engine (chat selector routing). */
export function isKiloModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  return modelId === KILO_MODEL_ID || modelId === KILO_REASONING_MODEL_ID;
}

/** Reasoning model flag — enables native `reasoning` on the gateway call. */
export function kiloModelWantsThinking(modelId: string | null | undefined): boolean {
  return modelId === KILO_REASONING_MODEL_ID;
}

export type KiloChatParams = {
  /** gateway model id — defaults to the standard built-in model */
  model?: string;
  messages: { role: string; content: string }[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  /** native reasoning (thinking) — defaults to model-dependent */
  thinking?: boolean;
  /**
   * Per-call time budget (ms). Default 285s (full answers). Routing/class
   * calls (auto decisions, titles…) pass a SHORT budget: a non-streaming
   * call on a free gateway can queue for tens of seconds, and those calls
   * gate the user-visible first token (the "Réflexion" shimmer) — a
   * timeout fails open instead of hanging the whole turn.
   */
  timeoutMs?: number;
};

/** Chat completions endpoint (OpenAI-compatible). */
export function kiloChatUrl(): string {
  return `${KILO_GATEWAY_BASE_URL.replace(/\/+$/, '')}/chat/completions`;
}

/** Auth headers for the gateway. */
export function kiloGatewayHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${KILO_GATEWAY_API_KEY}`,
    'user-agent': 'Nelth-AI/1.0 (+kilo-gateway)',
  };
}

/** Build the gateway request body (OpenRouter-style reasoning controls). */
function buildBody(params: KiloChatParams): Record<string, any> {
  const model = params.model ?? KILO_MODEL_ID;
  const thinking = params.thinking ?? kiloModelWantsThinking(model);
  const body: Record<string, any> = {
    model,
    messages: params.messages.map((m) => ({
      role: m.role === 'system' || m.role === 'user' || m.role === 'assistant' ? m.role : 'user',
      content: m.content,
    })),
    stream: params.stream === true,
    // The gateway streams the chain-of-thought in `delta.reasoning` only
    // when reasoning is enabled; disabled keeps the output content-only.
    reasoning: { enabled: thinking },
    include_reasoning: thinking,
  };
  if (typeof params.temperature === 'number') body.temperature = params.temperature;
  if (typeof params.top_p === 'number') body.top_p = params.top_p;
  if (typeof params.max_tokens === 'number' && params.max_tokens > 0) body.max_tokens = params.max_tokens;
  return body;
}

/** Non-streaming chat completion → OpenAI-compatible JSON object. */
export async function kiloChatCompletion(params: KiloChatParams): Promise<any> {
  const timeoutMs = Math.max(1_000, Math.min(params.timeoutMs ?? 285_000, 285_000));
  // Keyless fallback: the built-in z-ai engine answers in place of the
  // gateway (same wire format — decisions, titles, autocompletions…).
  // Same time budget: the SDK has NO timeout of its own and rate-limits
  // (429) under parallel load — without the race a stuck SDK call hangs
  // the caller for minutes.
  if (kiloFallbackActive()) {
    const { zaiChatCompletion } = await import('@/lib/zai-llm');
    const thinking = params.thinking ?? kiloModelWantsThinking(params.model ?? KILO_MODEL_ID);
    const work = zaiChatCompletion({
      messages: params.messages,
      stream: false,
      temperature: params.temperature,
      top_p: params.top_p,
      max_tokens: params.max_tokens,
      thinking: thinking ? 'enabled' : 'disabled',
    });
    work.catch(() => {}); // the loser of the race must not surface as unhandled
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`z-ai completion exceeded its ${timeoutMs}ms budget`)),
        timeoutMs
      );
    });
    try {
      return await Promise.race([work, budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const res = await fetch(kiloChatUrl(), {
    method: 'POST',
    headers: kiloGatewayHeaders(),
    body: JSON.stringify(buildBody({ ...params, stream: false })),
    // 285s: just under the 300s platform maxDuration so a hung gateway
    // surfaces as a JSON error instead of Vercel's hard function kill.
    // Short budgets (decisions/titles) abort proportionally earlier.
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Kilo gateway error ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

/** Title generation helper (tasks.py generate_title equivalent for Kilo). */
export async function kiloGenerateTitle(prompt: string): Promise<string | null> {
  try {
    const data: any = await kiloChatCompletion({
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      max_tokens: 200,
      thinking: false, // titles never need chain-of-thought
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
