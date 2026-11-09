/**
 * Built-in TokenHarbor LLM engine (chat completions) — TS-port extension.
 *
 * Third built-in chat model, exposed through the OpenAI-compatible
 * TokenHarbor gateway (https://tokenharbor.ai/v1 — auth: `Bearer
 * TOKENHARBOR_API_KEY`):
 *
 *   deepseek-v4.1-flash:free — fast multimodal (vision) chat model,
 *   shown in the selector as "Nelth-4.0_Flash".
 *
 * Wire format is OpenAI-compatible for both JSON responses and SSE streams
 * (`choices[0].delta.content` chunks), and image input rides as standard
 * `image_url` content blocks (data URLs resolved server-side from the chat
 * attachments — see v12-flow's vision injection).
 *
 * Thinking is DISABLED at the model level (`thinking: { type: "disabled" }`):
 * the flash tier answers directly, no chain-of-thought. Unlike the Kilo
 * engine there is no keyless fallback — without TOKENHARBOR_API_KEY the
 * model is simply not listed and chat requests 404.
 *
 * NOTE — the gateway applies region-based access control on the CALLER's
 * egress IP: some regions (e.g. Hong Kong) are refused with
 * `region_blocked`. Production (Vercel US region) is served fine.
 */

/** TokenHarbor base URL (OpenAI-compatible routes under /v1). */
export const TOKENHARBOR_BASE_URL =
  process.env.TOKENHARBOR_BASE_URL || 'https://tokenharbor.ai/v1';

/** TokenHarbor API key (tokenharbor.ai → API Keys, `thk_live_…`). */
export const TOKENHARBOR_API_KEY = process.env.TOKENHARBOR_API_KEY || '';

/** True when the built-in flash model can be served (key configured). */
export function tokenharborAvailable(): boolean {
  return TOKENHARBOR_API_KEY.length > 0;
}

/** Built-in flash chat model — TokenHarbor DeepSeek v4.1 Flash, shown as "Nelth-4.0_Flash". */
export const TH_MODEL_ID = 'deepseek-v4.1-flash:free';
export const TH_MODEL_NAME = 'Nelth-4.0_Flash';
// No description: the main (empty chat) view shows a personalized greeting
// instead of a model blurb (parity with the two Kilo built-ins).
export const TH_MODEL_DESCRIPTION = '';

/** All model ids owned by this engine (chat selector routing). */
export function isTokenharborModel(modelId: string | null | undefined): boolean {
  return !!modelId && modelId === TH_MODEL_ID;
}

/** Reasoning model flag — the flash tier NEVER thinks (direct answers). */
export function tokenharborModelWantsThinking(modelId: string | null | undefined): boolean {
  return false;
}

/**
 * Vision capability — the flash model accepts image input (`image_url`
 * content blocks). v12-flow uses this to convert this turn's attachments
 * into data-URL image parts on the last user message.
 */
export function modelSupportsVision(modelId: string | null | undefined): boolean {
  return isTokenharborModel(modelId);
}

/** Chat completions endpoint (OpenAI-compatible). */
export function tokenharborChatUrl(): string {
  return `${TOKENHARBOR_BASE_URL.replace(/\/+$/, '')}/chat/completions`;
}

/** Auth headers for the gateway. */
export function tokenharborHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${TOKENHARBOR_API_KEY}`,
    'user-agent': 'Nelth-AI/1.0 (+tokenharbor)',
  };
}
