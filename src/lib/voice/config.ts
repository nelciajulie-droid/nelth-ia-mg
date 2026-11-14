/**
 * Voice server configuration — every environment variable documented.
 * Secrets NEVER reach the browser.
 *
 * STT: NONE on the server. Speech recognition runs in the browser via
 * @untemps/react-vocal (default WebSpeechEngine — Web Speech API); there
 * is no remote STT URL, secret or model to configure anymore.
 */

/** Mandated voice LLM: NVIDIA Nemotron through the Kilo gateway. */
export const VOICE_LLM_MODEL = process.env.VOICE_LLM_MODEL || 'nvidia/nemotron-3.5-super-vl:free';
export const KILO_API_KEY = process.env.KILO_API_KEY || process.env.KILO_GATEWAY_API_KEY || '';
export const KILO_VOICE_BASE_URL = (
  process.env.KILO_VOICE_BASE_URL ||
  (KILO_API_KEY === process.env.KILO_GATEWAY_API_KEY && process.env.KILO_GATEWAY_BASE_URL) ||
  'https://api.kilo.ai/api/gateway/v1'
).replace(/\/+$/, '');

/** TTS provider: edge ONLY (node-edge-tts, mandated primary — no fallback
 *  provider is ever used). */
export const VOICE_TTS_PROVIDER = 'edge';

/** Default language for the voice UI. */
export const VOICE_DEFAULT_LANGUAGE = process.env.VOICE_DEFAULT_LANGUAGE || 'fr';

/** Default Edge TTS voice (fr). */
export const VOICE_DEFAULT_ID =
  process.env.VOICE_DEFAULT_ID || (VOICE_DEFAULT_LANGUAGE === 'fr' ? 'fr-FR-DeniseNeural' : 'en-US-AriaNeural');

/** Default speaking rate / pitch (Edge TTS syntax). */
export const VOICE_TTS_RATE = process.env.VOICE_TTS_RATE || '+0%';
export const VOICE_TTS_PITCH = process.env.VOICE_TTS_PITCH || '+0Hz';

/** Hard session caps (security & resources). */
export const VOICE_MAX_SESSION_DURATION_SEC = Math.max(60, Number(process.env.VOICE_MAX_SESSION_DURATION) || 1800);
/** Max pending TTS segments in the bounded queue (backpressure). */
export const VOICE_TTS_QUEUE_MAX = 5;

/** Interruption behaviour (browser-side energy barge-in). */
export const VOICE_INTERRUPTION_ENABLED = process.env.VOICE_INTERRUPTION_ENABLED !== 'false';

/** Which engine serves the voice LLM right now (diagnostics only). */
export function voiceLlmEngine(): 'kilo-nemotron' | 'kilo-gateway' | 'kilo-unconfigured' {
  if (!KILO_API_KEY) return 'kilo-unconfigured';
  if (KILO_API_KEY === process.env.KILO_GATEWAY_API_KEY) return 'kilo-gateway';
  return 'kilo-nemotron';
}
