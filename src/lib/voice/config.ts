/**
 * Voice server configuration — every environment variable documented
 * (mission §18). Secrets NEVER reach the browser.
 */

/** Remote streaming STT service (sherpa-onnx host). Next.js forwards PCM
 * server-to-server; the browser never performs inference. */
export const STT_REMOTE_URL = (process.env.STT_REMOTE_URL || 'http://127.0.0.1:3031').replace(/\/+$/, '');

/** Shared secret between the Vercel backend and the STT host. */
export const STT_AUTH_SECRET = process.env.STT_AUTH_SECRET || '';

/** Mandated STT model — nvidia/nemotron-3.5-asr-streaming-0.6b, now REALLY
 *  served by the remote STT host through the OFFICIAL k2-fsa export
 *  (560ms INT8, scripts/nemo/nemotron-3.5-asr-streaming-0.6b). The
 *  previously tested zipformers remain available via STT_ENGINE=zipformer
 *  on the service host. */
export const STT_MODEL = process.env.STT_MODEL || 'nvidia/nemotron-3.5-asr-streaming-0.6b';
export const STT_MODEL_PRECISION = process.env.STT_MODEL_PRECISION || 'int8';

/** Mandated voice LLM: NVIDIA Nemotron through the Kilo gateway. */
export const VOICE_LLM_MODEL = process.env.VOICE_LLM_MODEL || 'nvidia/nemotron-3.5-super-vl:free';
export const KILO_API_KEY = process.env.KILO_API_KEY || process.env.KILO_GATEWAY_API_KEY || '';
export const KILO_VOICE_BASE_URL = (
  process.env.KILO_VOICE_BASE_URL ||
  (KILO_API_KEY === process.env.KILO_GATEWAY_API_KEY && process.env.KILO_GATEWAY_BASE_URL) ||
  'https://api.kilo.ai/api/gateway/v1'
).replace(/\/+$/, '');

/** TTS provider: edge (node-edge-tts, mandated primary) | zai (built-in
 * keyless fallback for hosts where Edge TTS is rate-limited, e.g. this
 * sandbox egress). */
export const VOICE_TTS_PROVIDER = (process.env.VOICE_TTS_PROVIDER || (KILO_API_KEY ? 'edge' : 'edge')).toLowerCase();

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
export const VOICE_MAX_AUDIO_SIZE = Math.max(1_000_000, Number(process.env.VOICE_MAX_AUDIO_SIZE) || 200_000_000);
/** Max pending TTS segments in the bounded queue (backpressure). */
export const VOICE_TTS_QUEUE_MAX = 5;

/** VAD end-of-turn silence (ms) and interruption behaviour. */
export const VOICE_VAD_SILENCE_MS = Math.max(200, Number(process.env.VOICE_VAD_SILENCE_MS) || 750);
export const VOICE_INTERRUPTION_ENABLED = process.env.VOICE_INTERRUPTION_ENABLED !== 'false';

/** Which engine serves the voice LLM right now (diagnostics only). */
export function voiceLlmEngine(): 'kilo-nemotron' | 'kilo-gateway' | 'zai-fallback' {
  if (!KILO_API_KEY) return 'zai-fallback';
  if (KILO_API_KEY === process.env.KILO_GATEWAY_API_KEY) return 'kilo-gateway';
  return 'kilo-nemotron';
}
