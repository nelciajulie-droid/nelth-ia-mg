import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { env, ERROR_MESSAGES, DEFAULT_USER_PERMISSIONS } from '@/lib/constants';
import { configGet, configSet } from '@/lib/config';
import { hasPermission } from '@/lib/access-control';
import { ttsBuiltinSpeak, sttBuiltinTranscribe, BUILTIN_TTS_VOICES, BUILTIN_TTS_MODEL_ID } from '@/lib/audio-builtin';

/**
 * Port of open_webui/routers/audio/__init__.py (v0.12.5) — /api/v1/audio/*.
 *
 * Deviations (documented):
 *   • The Python-local Whisper STT / transformers TTS pipelines cannot be
 *     bundled; the default engine '' instead selects the built-in zero-config
 *     engine (src/lib/audio-builtin.ts) — voice features work out of the box
 *     exactly like the original's local pipelines did.
 *   • The explicit 'transformers' engine name keeps the slim 503 error (the
 *     Python pipeline itself is not portable).
 *   • OpenAI Realtime TTS requires a WebSocket client; after the request
 *     validation gates it returns 502 'Could not connect to OpenAI Realtime.'
 *   • Disk speech cache (CACHE_DIR/audio/speech) is not persisted serverless —
 *     every /speech request proxies through (no cache hits).
 *   • /realtime (websocket endpoint in audio/realtime.py) is not ported
 *     (optional feature — disabled by default in the original too).
 *   • deepgram / azure / mistral STT engines are ported as HTTP proxies.
 */

function err(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

const envBool = (key: string, def: string) => (process.env[key] ?? def).toLowerCase() === 'true';

const OPENAI_API_BASE_URL = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ELEVENLABS_API_BASE_URL = process.env.ELEVENLABS_API_BASE_URL || 'https://api.elevenlabs.io';

function envList(key: string, def: string): string[] {
  return (process.env[key] ?? def)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function envJson(key: string, def: unknown): any {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return def;
  try {
    return JSON.parse(raw);
  } catch {
    return def;
  }
}

// ---------------------------------------------------------------------------
// Config key maps (audio/__init__.py TTS/STT/REALTIME_CONFIG_KEYS)
// ---------------------------------------------------------------------------

const TTS_CONFIG_KEYS: Record<string, { key: string; env: unknown }> = {
  OPENAI_API_BASE_URL: { key: 'audio.tts.openai.api_base_url', env: process.env.AUDIO_TTS_OPENAI_API_BASE_URL ?? OPENAI_API_BASE_URL },
  OPENAI_API_KEY: { key: 'audio.tts.openai.api_key', env: process.env.AUDIO_TTS_OPENAI_API_KEY ?? OPENAI_API_KEY },
  OPENAI_PARAMS: { key: 'audio.tts.openai.params', env: envJson('AUDIO_TTS_OPENAI_PARAMS', {}) },
  API_KEY: { key: 'audio.tts.api_key', env: process.env.AUDIO_TTS_API_KEY ?? '' },
  ENGINE: { key: 'audio.tts.engine', env: process.env.AUDIO_TTS_ENGINE ?? '' },
  MODEL: { key: 'audio.tts.model', env: process.env.AUDIO_TTS_MODEL ?? 'tts-1' },
  VOICE: { key: 'audio.tts.voice', env: process.env.AUDIO_TTS_VOICE ?? 'alloy' },
  REALTIME_TTS_PROMPT_TEMPLATE: { key: 'audio.tts.realtime.prompt_template', env: process.env.REALTIME_TTS_PROMPT_TEMPLATE ?? null },
  SPLIT_ON: { key: 'audio.tts.split_on', env: process.env.AUDIO_TTS_SPLIT_ON ?? 'punctuation' },
  AZURE_SPEECH_REGION: { key: 'audio.tts.azure.speech_region', env: process.env.AUDIO_TTS_AZURE_SPEECH_REGION ?? '' },
  AZURE_SPEECH_BASE_URL: { key: 'audio.tts.azure.speech_base_url', env: process.env.AUDIO_TTS_AZURE_SPEECH_BASE_URL ?? '' },
  AZURE_SPEECH_OUTPUT_FORMAT: {
    key: 'audio.tts.azure.speech_output_format',
    env: process.env.AUDIO_TTS_AZURE_SPEECH_OUTPUT_FORMAT ?? 'audio-24khz-160kbitrate-mono-mp3',
  },
  MISTRAL_API_KEY: { key: 'audio.tts.mistral.api_key', env: process.env.AUDIO_TTS_MISTRAL_API_KEY ?? '' },
  MISTRAL_API_BASE_URL: { key: 'audio.tts.mistral.api_base_url', env: process.env.AUDIO_TTS_MISTRAL_API_BASE_URL ?? 'https://api.mistral.ai/v1' },
};

const STT_CONFIG_KEYS: Record<string, { key: string; env: unknown }> = {
  OPENAI_API_BASE_URL: { key: 'audio.stt.openai.api_base_url', env: process.env.AUDIO_STT_OPENAI_API_BASE_URL ?? OPENAI_API_BASE_URL },
  OPENAI_API_KEY: { key: 'audio.stt.openai.api_key', env: process.env.AUDIO_STT_OPENAI_API_KEY ?? OPENAI_API_KEY },
  OPENAI_API_REQUEST_FORMAT: { key: 'audio.stt.openai.api_request_format', env: process.env.AUDIO_STT_OPENAI_API_REQUEST_FORMAT ?? 'multipart' },
  ENGINE: { key: 'audio.stt.engine', env: process.env.AUDIO_STT_ENGINE ?? '' },
  MODEL: { key: 'audio.stt.model', env: process.env.AUDIO_STT_MODEL ?? '' },
  SUPPORTED_CONTENT_TYPES: { key: 'audio.stt.supported_content_types', env: envList('AUDIO_STT_SUPPORTED_CONTENT_TYPES', '') },
  ALLOWED_EXTENSIONS: { key: 'audio.stt.allowed_extensions', env: envList('AUDIO_STT_ALLOWED_EXTENSIONS', 'mp3,wav,m4a,webm,ogg,flac,mp4,mpga,mpeg') },
  WHISPER_MODEL: { key: 'audio.stt.whisper_model', env: process.env.WHISPER_MODEL ?? '' },
  DEEPGRAM_API_KEY: { key: 'audio.stt.deepgram.api_key', env: process.env.DEEPGRAM_API_KEY ?? '' },
  AZURE_API_KEY: { key: 'audio.stt.azure.api_key', env: process.env.AUDIO_STT_AZURE_API_KEY ?? '' },
  AZURE_REGION: { key: 'audio.stt.azure.region', env: process.env.AUDIO_STT_AZURE_REGION ?? '' },
  AZURE_LOCALES: { key: 'audio.stt.azure.locales', env: process.env.AUDIO_STT_AZURE_LOCALES ?? '' },
  AZURE_BASE_URL: { key: 'audio.stt.azure.base_url', env: process.env.AUDIO_STT_AZURE_BASE_URL ?? '' },
  AZURE_MAX_SPEAKERS: { key: 'audio.stt.azure.max_speakers', env: process.env.AUDIO_STT_AZURE_MAX_SPEAKERS ?? '' },
  MISTRAL_API_KEY: { key: 'audio.stt.mistral.api_key', env: process.env.AUDIO_STT_MISTRAL_API_KEY ?? '' },
  MISTRAL_API_BASE_URL: { key: 'audio.stt.mistral.api_base_url', env: process.env.AUDIO_STT_MISTRAL_API_BASE_URL ?? 'https://api.mistral.ai/v1' },
  MISTRAL_USE_CHAT_COMPLETIONS: { key: 'audio.stt.mistral.use_chat_completions', env: envBool('AUDIO_STT_MISTRAL_USE_CHAT_COMPLETIONS', 'false') },
};

const REALTIME_CONFIG_KEYS: Record<string, { key: string; env: unknown }> = {
  ENABLED: { key: 'audio.realtime.enabled', env: envBool('AUDIO_REALTIME_ENABLED', 'False') },
  PROVIDER: { key: 'audio.realtime.provider', env: process.env.AUDIO_REALTIME_PROVIDER ?? 'openai' },
  AUTH_TYPE: { key: 'audio.realtime.auth_type', env: process.env.AUDIO_REALTIME_AUTH_TYPE ?? 'api_key' },
  OPENAI_API_BASE_URL: { key: 'audio.realtime.openai.api_base_url', env: process.env.AUDIO_REALTIME_OPENAI_API_BASE_URL ?? 'https://api.openai.com/v1' },
  OPENAI_API_KEY: { key: 'audio.realtime.openai.api_key', env: process.env.AUDIO_REALTIME_OPENAI_API_KEY ?? '' },
  MODEL: { key: 'audio.realtime.model', env: process.env.AUDIO_REALTIME_MODEL ?? 'gpt-realtime-2.1-mini' },
  VOICE: { key: 'audio.realtime.voice', env: process.env.AUDIO_REALTIME_VOICE ?? 'marin' },
  TRANSCRIPTION_MODEL: { key: 'audio.realtime.transcription_model', env: process.env.AUDIO_REALTIME_TRANSCRIPTION_MODEL ?? 'gpt-transcribe' },
  INPUT_PARAMS: { key: 'audio.realtime.input_params', env: envJson('AUDIO_REALTIME_INPUT_PARAMS', null) },
  REALTIME_CALL_PROMPT_TEMPLATE: { key: 'audio.realtime.prompt_template', env: process.env.REALTIME_CALL_PROMPT_TEMPLATE ?? null },
};

async function getConfigValues(keyMap: Record<string, { key: string; env: unknown }>): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  for (const [field, { key, env: envDefault }] of Object.entries(keyMap)) {
    values[field] = await configGet<unknown>(key, envDefault as never);
  }
  return values;
}

// ---------------------------------------------------------------------------
// TTS engines
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 120_000;

/** Python _raise_tts_error — standardized provider failure. */
async function raiseTtsError(res: Response | null, exc: unknown): Promise<never> {
  const code = res && res.status >= 400 ? res.status : 500;
  let detail = 'Nelth-AI: Server Connection Error';
  if (res !== null) {
    try {
      const body = await res.clone().json();
      if (body && typeof body === 'object' && 'error' in body) {
        const msg = (body as any).error;
        detail = `External: ${typeof msg === 'object' && msg !== null ? (msg.message ?? msg) : msg}`;
      } else if (body && typeof body === 'object' && 'message' in body) {
        detail = `External: ${(body as any).message}`;
      }
    } catch {
      detail = `External: ${exc instanceof Error ? exc.message : String(exc)}`;
    }
  }
  err(code, detail);
}

function audioResponse(bytes: ArrayBuffer, contentType: string): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': contentType,
      'cache-control': 'no-store',
    },
  });
}

/** Python _tts_openai — OpenAI-compatible TTS proxy. */
async function ttsOpenai(payload: Record<string, any>): Promise<Response> {
  payload['model'] = await configGet<string>('audio.tts.model', 'tts-1');
  if (!payload.voice) payload.voice = await configGet<string>('audio.tts.voice', 'alloy');
  const params = (await configGet<Record<string, any> | null>('audio.tts.openai.params', null)) ?? {};
  payload = { ...payload, ...params };
  const apiKey = await configGet<string>('audio.tts.openai.api_key', OPENAI_API_KEY);
  const apiBaseUrl = await configGet<string>('audio.tts.openai.api_base_url', OPENAI_API_BASE_URL);

  let res: Response | null = null;
  try {
    res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    });
    if (!res.ok) await raiseTtsError(res, new Error(`HTTP ${res.status}`));
    const contentType = res.headers.get('content-type') ?? 'audio/mpeg';
    return audioResponse(await res.arrayBuffer(), contentType);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return raiseTtsError(res, e);
  }
}

/** Python _tts_elevenlabs. */
async function ttsElevenlabs(payload: Record<string, any>): Promise<Response> {
  const voiceId = String(payload.voice ?? '').trim();
  if (!voiceId) err(400, 'Invalid voice id');

  const availableVoices = await getAvailableVoices();
  if (Object.keys(availableVoices).length && !(voiceId in availableVoices)) err(400, 'Invalid voice id');

  let res: Response | null = null;
  try {
    res = await fetch(`${ELEVENLABS_API_BASE_URL.replace(/\/$/, '')}/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        accept: 'audio/mpeg',
        'content-type': 'application/json',
        'xi-api-key': await configGet<string>('audio.tts.api_key', ''),
      },
      body: JSON.stringify({
        text: payload.input,
        model_id: await configGet<string>('audio.tts.model', 'tts-1'),
        voice_settings: { stability: 0.5, similarity_boost: 0.5 },
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    });
    if (!res.ok) await raiseTtsError(res, new Error(`HTTP ${res.status}`));
    const contentType = res.headers.get('content-type') ?? 'audio/mpeg';
    return audioResponse(await res.arrayBuffer(), contentType);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return raiseTtsError(res, e);
  }
}

/** Python _tts_azure. */
async function ttsAzure(payload: Record<string, any>): Promise<Response> {
  const azRegion = (await configGet<string>('audio.tts.azure.speech_region', '')) || 'eastus';
  const azBase = await configGet<string>('audio.tts.azure.speech_base_url', '');
  const language = payload.voice ?? (await configGet<string>('audio.tts.voice', 'alloy'));
  const locale = String(language).split('-').slice(0, 2).join('-');
  const outputFormat = await configGet<string>('audio.tts.azure.speech_output_format', 'audio-24khz-160kbitrate-mono-mp3');

  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escape(locale)}">` +
    `<voice name="${escape(String(language))}">${escape(String(payload.input ?? ''))}</voice>` +
    `</speak>`;

  let res: Response | null = null;
  try {
    res = await fetch(`${(azBase || `https://${azRegion}.tts.speech.microsoft.com`).replace(/\/$/, '')}/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': await configGet<string>('audio.tts.api_key', ''),
        'content-type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': outputFormat,
      },
      body: ssml,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    });
    if (!res.ok) await raiseTtsError(res, new Error(`HTTP ${res.status}`));
    const contentType = res.headers.get('content-type') ?? 'audio/mpeg';
    return audioResponse(await res.arrayBuffer(), contentType);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return raiseTtsError(res, e);
  }
}

/** Python _tts_mistral. */
async function ttsMistral(payload: Record<string, any>): Promise<Response> {
  const apiKey = await configGet<string>('audio.tts.mistral.api_key', '');
  const apiBaseUrl = (await configGet<string>('audio.tts.mistral.api_base_url', 'https://api.mistral.ai/v1')) || 'https://api.mistral.ai/v1';
  if (!apiKey) err(400, 'Mistral API key is required for Mistral TTS');

  let res: Response | null = null;
  try {
    res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        input: payload.input ?? '',
        model: (await configGet<string>('audio.tts.model', 'tts-1')) || 'voxtral-mini-tts-2603',
        voice_id: payload.voice ?? '',
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    });
    if (!res.ok) await raiseTtsError(res, new Error(`HTTP ${res.status}`));
    const body = await res.json();
    const audioB64 = body?.audio_data ?? '';
    if (!audioB64) throw new Error('No audio_data in Mistral TTS response');
    return audioResponse(new Uint8Array(Buffer.from(String(audioB64), 'base64')).buffer as ArrayBuffer, 'audio/mpeg');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return raiseTtsError(res, e);
  }
}

/** Python _tts_transformers (slim path — no local pipeline in this runtime). */
async function ttsTransformers(): Promise<Response> {
  err(503, 'Configure an external text-to-speech engine. Local TTS is unavailable in slim.');
}

/** Built-in zero-config engine (TS-port extension — replaces the Python-local
 *  transformers/Whisper pipelines that ran with the default engine '').
 *  Long text is chunked at sentence boundaries and spoken as one continuous
 *  mp3 track (see src/lib/audio-builtin.ts). */
async function ttsBuiltin(payload: Record<string, any>): Promise<Response> {
  const input = typeof payload.input === 'string' ? payload.input : '';
  if (!input.trim()) err(400, 'Text is required for speech synthesis');
  try {
    const { bytes, contentType } = await ttsBuiltinSpeak({
      input,
      voice: typeof payload.voice === 'string' ? payload.voice : null,
      speed: payload.speed ?? null,
    });
    return audioResponse(new Uint8Array(bytes).buffer as ArrayBuffer, contentType);
  } catch (e) {
    err(500, `Built-in speech synthesis failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Python _tts_openai_realtime — request validation gates, then a documented
 * 502 (no WebSocket synthesis available serverless). */
async function ttsOpenaiRealtime(payload: Record<string, any>): Promise<Response> {
  const apiKey = await configGet<string>('audio.tts.openai.api_key', OPENAI_API_KEY);
  if (typeof apiKey !== 'string' || !apiKey.trim()) err(400, 'Configure an OpenAI Realtime API key.');
  const model = await configGet<string>('audio.tts.model', 'tts-1');
  const voice = payload.voice ?? (await configGet<string>('audio.tts.voice', 'alloy'));
  const baseUrl = await configGet<string>('audio.tts.openai.api_base_url', OPENAI_API_BASE_URL);
  if (![model, voice, baseUrl].every((v) => typeof v === 'string' && v.trim())) {
    err(400, 'Configure the OpenAI Realtime model, voice, and API base URL.');
  }
  err(502, 'Could not connect to OpenAI Realtime.');
}

const TTS_ENGINES: Record<string, (payload: Record<string, any>) => Promise<Response>> = {
  // Legacy 'zai' config value (saved by earlier builds) keeps resolving to
  // the built-in engine — Google Translate TTS, NOT any z.ai provider.
  zai: ttsBuiltin,
  builtin: ttsBuiltin,
  openai: ttsOpenai,
  'openai-realtime': ttsOpenaiRealtime,
  elevenlabs: ttsElevenlabs,
  azure: ttsAzure,
  transformers: ttsTransformers,
  mistral: ttsMistral,
};

// ---------------------------------------------------------------------------
// Models / voices listings
// ---------------------------------------------------------------------------

const OPENAI_DEFAULT_VOICES: Record<string, string> = {
  alloy: 'alloy',
  echo: 'echo',
  fable: 'fable',
  onyx: 'onyx',
  nova: 'nova',
  shimmer: 'shimmer',
};

async function getAvailableModels(): Promise<Array<Record<string, string>>> {
  const engine = await configGet<string>('audio.tts.engine', '');
  const availableModels: Array<Record<string, string>> = [];

  if (engine === '' || engine === 'zai' || engine === 'builtin') {
    // Built-in zero-config engine (default) — model fixed by the engine.
    availableModels.push({ id: BUILTIN_TTS_MODEL_ID });
  } else if (engine === 'openai') {
    const apiKey = (await configGet<string>('audio.tts.openai.api_key', OPENAI_API_KEY)) ?? '';
    if (!apiKey.trim()) {
      // Key-less selection → built-in engine model (see /speech resolution).
      availableModels.push({ id: BUILTIN_TTS_MODEL_ID });
    } else {
      const baseUrl = await configGet<string>('audio.tts.openai.api_base_url', OPENAI_API_BASE_URL);
      if (!baseUrl.startsWith('https://api.openai.com')) {
        try {
          const res = await fetch(`${baseUrl.replace(/\/$/, '')}/audio/models`, {
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) {
            const data = await res.json();
            availableModels.push(...(data?.models ?? []));
          } else {
            throw new Error(`HTTP ${res.status}`);
          }
        } catch {
          try {
            const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            availableModels.push(...(data?.data ?? data?.models ?? []));
          } catch {
            availableModels.push({ id: 'tts-1' }, { id: 'tts-1-hd' });
          }
        }
      } else {
        availableModels.push({ id: 'tts-1' }, { id: 'tts-1-hd' });
      }
    }
  } else if (engine === 'openai-realtime') {
    availableModels.push({ id: 'gpt-realtime-2.1-mini' }, { id: 'gpt-realtime-2.1' });
  } else if (engine === 'elevenlabs') {
    try {
      const res = await fetch(`${ELEVENLABS_API_BASE_URL.replace(/\/$/, '')}/v1/models`, {
        headers: {
          'xi-api-key': await configGet<string>('audio.tts.api_key', ''),
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const models = await res.json();
        for (const m of models ?? []) availableModels.push({ name: m.name, id: m.model_id });
      }
    } catch {
      // Python returns [] on failure
    }
  } else if (engine === 'mistral') {
    availableModels.push({ id: 'voxtral-mini-tts-2603' });
  }

  return availableModels;
}

async function getAvailableVoices(): Promise<Record<string, string>> {
  const engine = await configGet<string>('audio.tts.engine', '');

  if (engine === '' || engine === 'zai' || engine === 'builtin') {
    // Built-in zero-config engine (default).
    return { ...BUILTIN_TTS_VOICES };
  }

  if (engine === 'openai-realtime') {
    const voices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
    return Object.fromEntries(voices.map((v) => [v, v]));
  }

  if (engine === 'openai') {
    const apiKey = (await configGet<string>('audio.tts.openai.api_key', OPENAI_API_KEY)) ?? '';
    if (!apiKey.trim()) {
      // Key-less selection → built-in engine voices (see /speech resolution).
      return { ...BUILTIN_TTS_VOICES };
    }
    const baseUrl = await configGet<string>('audio.tts.openai.api_base_url', OPENAI_API_BASE_URL);
    if (!baseUrl.startsWith('https://api.openai.com')) {
      try {
        const res = await fetch(`${baseUrl.replace(/\/$/, '')}/audio/voices`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const out: Record<string, string> = {};
        for (const v of data?.voices ?? []) out[v.id] = v.name;
        return out;
      } catch {
        return { ...OPENAI_DEFAULT_VOICES };
      }
    }
    return { ...OPENAI_DEFAULT_VOICES };
  }

  if (engine === 'elevenlabs') {
    try {
      const res = await fetch(`${ELEVENLABS_API_BASE_URL.replace(/\/$/, '')}/v1/voices`, {
        headers: {
          'xi-api-key': await configGet<string>('audio.tts.api_key', ''),
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const out: Record<string, string> = {};
      for (const v of data?.voices ?? []) out[v.voice_id] = v.name;
      return out;
    } catch {
      return {};
    }
  }

  if (engine === 'azure') {
    try {
      const region = await configGet<string>('audio.tts.azure.speech_region', '');
      const baseUrl = await configGet<string>('audio.tts.azure.speech_base_url', '');
      const url = `${(baseUrl || `https://${region}.tts.speech.microsoft.com`).replace(/\/$/, '')}/cognitiveservices/voices/list`;
      const res = await fetch(url, {
        headers: { 'Ocp-Apim-Subscription-Key': await configGet<string>('audio.tts.api_key', '') },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const voices = await res.json();
      const out: Record<string, string> = {};
      for (const v of voices ?? []) out[v.ShortName] = `${v.DisplayName} (${v.ShortName})`;
      return out;
    } catch {
      return {};
    }
  }

  if (engine === 'mistral') {
    const apiKey = await configGet<string>('audio.tts.mistral.api_key', '');
    const apiBaseUrl = (await configGet<string>('audio.tts.mistral.api_base_url', 'https://api.mistral.ai/v1')) || 'https://api.mistral.ai/v1';
    if (apiKey) {
      try {
        const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/audio/voices`, {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const data = await res.json();
          const items = Array.isArray(data) ? data : (data?.items ?? []);
          const out: Record<string, string> = {};
          for (const v of items) {
            if (v && typeof v === 'object') {
              const vid = v.voice_id ?? v.id ?? '';
              if (vid) out[vid] = v.name ?? vid;
            }
          }
          return out;
        }
      } catch {
        // fallthrough
      }
    }
  }

  return {};
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // ------------------- GET /config (admin) -------------------
  {
    method: 'GET',
    path: 'config',
    auth: 'admin',
    handler: async (ctx) =>
      ctx.json({
        realtime: await getConfigValues(REALTIME_CONFIG_KEYS),
        tts: await getConfigValues(TTS_CONFIG_KEYS),
        stt: await getConfigValues(STT_CONFIG_KEYS),
      }),
  },

  // ------------------- POST /config/update (admin) -------------------
  {
    method: 'POST',
    path: 'config/update',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<Record<string, any>>();
      const currentTtsEngine = await configGet<string>('audio.tts.engine', '');

      // Engine '' selects the built-in zero-config engine (src/lib/audio-builtin.ts)
      // so it is always a valid choice; only the Python-local transformers
      // pipeline stays unavailable in this runtime.
      if (form?.tts?.ENGINE === 'transformers' && currentTtsEngine !== 'transformers') {
        err(400, 'Local TTS is unavailable in slim. Select an external text-to-speech engine.');
      }

      const upsert = async (section: Record<string, any> | undefined, keyMap: Record<string, { key: string; env: unknown }>) => {
        if (!section || typeof section !== 'object') return;
        for (const [field, { key }] of Object.entries(keyMap)) {
          if (field in section) await configSet(key, section[field]);
        }
      };
      await upsert(form?.realtime, REALTIME_CONFIG_KEYS);
      await upsert(form?.tts, TTS_CONFIG_KEYS);
      await upsert(form?.stt, STT_CONFIG_KEYS);

      return ctx.json({
        realtime: await getConfigValues(REALTIME_CONFIG_KEYS),
        tts: await getConfigValues(TTS_CONFIG_KEYS),
        stt: await getConfigValues(STT_CONFIG_KEYS),
      });
    },
  },

  // ------------------- POST /speech (user) -------------------
  {
    method: 'POST',
    path: 'speech',
    auth: 'user',
    handler: async (ctx) => {
      const engine = await configGet<string>('audio.tts.engine', '');
      if (engine === 'transformers') {
        err(503, 'Configure an external text-to-speech engine. Local TTS is unavailable in slim.');
      }
      // Engine '' (the original default) selects the built-in zero-config
      // engine — dispatch below.

      const user = ctx.user!;
      if (user.role !== 'admin') {
        const permissions = await configGet<Record<string, any> | null>(
          'user.permissions',
          DEFAULT_USER_PERMISSIONS as unknown as Record<string, any>
        );
        if (!(await hasPermission(user.id, 'chat.tts', permissions))) {
          err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
        }
      }

      // openai-realtime payload validation happens inside its handler.
      let payload: Record<string, any>;
      try {
        payload = await ctx.body<Record<string, any>>();
      } catch {
        err(400, 'Invalid JSON payload');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        err(400, 'Invalid JSON payload');
      }

      // Engine resolution (images.ts parity): '' (browser default when
      // unconfigured) and a key-less 'openai'/'openai-realtime' selection both
      // resolve to the built-in zero-config engine, so Read Aloud works as
      // soon as a server engine is selected — no API key required.
      const openaiKey = (await configGet<string>('audio.tts.openai.api_key', OPENAI_API_KEY)) ?? '';
      const effectiveEngine =
        engine === '' || ((engine === 'openai' || engine === 'openai-realtime') && !openaiKey.trim())
          ? 'builtin'
          : engine;
      const handler = TTS_ENGINES[effectiveEngine];
      if (!handler) err(400, `Unsupported TTS engine: ${engine}`);
      return handler(payload);
    },
  },

  // ------------------- POST /transcriptions (user) -------------------
  {
    method: 'POST',
    path: 'transcriptions',
    auth: 'user',
    handler: async (ctx) => {
      const user = ctx.user!;
      if (user.role !== 'admin') {
        const permissions = await configGet<Record<string, any> | null>(
          'user.permissions',
          DEFAULT_USER_PERMISSIONS as unknown as Record<string, any>
        );
        if (!(await hasPermission(user.id, 'chat.stt', permissions))) {
          err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
        }
      }

      const form = await ctx.req.formData().catch(() => null);
      if (!form) err(400, 'Transcription failed.');
      const fileField = form!.get('file');
      if (!(fileField instanceof File)) err(400, 'Transcription failed.');
      const language = form!.get('language');
      const languageStr = typeof language === 'string' && language ? language : null;

      // strict_match_mime_type with the default types when unconfigured.
      const supportedTypes = await configGet<string[]>('audio.stt.supported_content_types', []);
      const contentType = fileField.type || 'application/octet-stream';
      const effective = (supportedTypes ?? []).filter((t) => t.trim() && t.includes('/'));
      const allowed = effective.length
        ? effective.some((t) => {
            if (t === contentType) return true;
            if (t.endsWith('/*')) return contentType.startsWith(t.slice(0, -1));
            return false;
          })
        : contentType.startsWith('audio/') || contentType === 'video/webm';
      if (!allowed) {
        err(
          400,
          "Oops! It seems like the file format you're trying to upload is not supported. Please upload a file with a supported format and try again."
        );
      }

      const safeName = (fileField.name ?? '').split(/[\\/]/).pop() ?? '';
      const ext = safeName.includes('.') ? (safeName.split('.').pop() ?? '').toLowerCase() : '';
      const allowedExtensions = await configGet<string[]>(
        'audio.stt.allowed_extensions',
        envList('AUDIO_STT_ALLOWED_EXTENSIONS', 'mp3,wav,m4a,webm,ogg,flac,mp4,mpga,mpeg')
      );
      if (allowedExtensions && allowedExtensions.length && !allowedExtensions.includes(ext)) {
        err(400, 'Invalid audio file extension');
      }

      const id = crypto.randomUUID();
      const filename = `${id}.${ext}`;

      const engine = await configGet<string>('audio.stt.engine', '');
      const audioBytes = Buffer.from(await fileField.arrayBuffer());

      if (engine === '' || engine === 'zai' || engine === 'builtin') {
        // Built-in zero-config engine (TS-port extension) — replaces the
        // Python-local Whisper pipeline that ran with the default engine ''.
        try {
          const text = await sttBuiltinTranscribe({ bytes: audioBytes });
          return ctx.json({ text, filename });
        } catch (e) {
          err(500, `Error transcribing chunk: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (engine === 'deepgram') {
        // Python _transcribe_deepgram (DeepgramTranscription) — HTTP proxy.
        const apiKey = await configGet<string>('audio.stt.deepgram.api_key', process.env.DEEPGRAM_API_KEY ?? '');
        const model = (await configGet<string>('audio.stt.model', '')) || 'nova-2';
        try {
          const res = await fetch(
            `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(model)}&punctuate=true&smart_format=true`,
            {
              method: 'POST',
              headers: {
                authorization: `Token ${apiKey}`,
                'content-type': fileField.type || 'application/octet-stream',
              },
              body: audioBytes,
              signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
            }
          );
          if (!res.ok) {
            let detail = `HTTP ${res.status}`;
            try {
              const b = await res.json();
              const msg = b?.errorMessage ?? b?.reason;
              if (typeof msg === 'string' && msg) detail = msg;
            } catch { /* keep status detail */ }
            err(500, `Error transcribing chunk: External: ${detail}`);
          }
          const data = await res.json();
          const text = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
          return ctx.json({ text, filename });
        } catch (e) {
          if (e instanceof HttpError) throw e;
          err(500, `Error transcribing chunk: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (engine === 'azure') {
        // Python _transcribe_azure (Azure Speech SDK) — REST conversation
        // endpoint proxy (single-shot recognition).
        const region = await configGet<string>('audio.stt.azure.region', '');
        const apiKey = await configGet<string>('audio.stt.azure.api_key', '');
        const locales = await configGet<string[]>('audio.stt.azure.locales', []);
        const language = languageStr ?? locales[0] ?? 'en-US';
        try {
          const res = await fetch(
            `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(language)}&format=simple`,
            {
              method: 'POST',
              headers: {
                'Ocp-Apim-Subscription-Key': apiKey,
                'content-type': fileField.type || 'audio/webm; codecs=opus',
                accept: 'application/json',
              },
              body: audioBytes,
              signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
            }
          );
          if (!res.ok) err(500, `Error transcribing chunk: External: HTTP ${res.status}`);
          const data = await res.json();
          return ctx.json({ text: data?.DisplayText ?? '', filename });
        } catch (e) {
          if (e instanceof HttpError) throw e;
          err(500, `Error transcribing chunk: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (engine === 'mistral') {
        // Python _transcribe_mistral — OpenAI-compatible multipart proxy.
        const apiKey = await configGet<string>('audio.stt.mistral.api_key', '');
        const apiBaseUrl = (await configGet<string>('audio.stt.mistral.api_base_url', 'https://api.mistral.ai/v1')) || 'https://api.mistral.ai/v1';
        try {
          const fd = new FormData();
          fd.set('model', (await configGet<string>('audio.stt.model', '')) || 'voxtral-mini-2603a');
          if (languageStr) fd.set('language', languageStr);
          fd.set('file', fileField, filename);
          const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}` },
            body: fd,
            signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
          });
          if (!res.ok) {
            let detail = `HTTP ${res.status}`;
            try {
              const b = await res.json();
              const msg = b?.message ?? b?.error;
              if (typeof msg === 'string' && msg) detail = msg;
            } catch { /* keep status detail */ }
            err(500, `Error transcribing chunk: External: ${detail}`);
          }
          const data = await res.json();
          return ctx.json({ text: data?.text ?? '', filename });
        } catch (e) {
          if (e instanceof HttpError) throw e;
          err(500, `Error transcribing chunk: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (engine !== 'openai') {
        // Unsupported engine — the generic failure path Python takes.
        err(400, 'Transcription failed.');
      }

      // _transcribe_openai — multipart proxy with language fallback.
      const apiKey = await configGet<string>('audio.stt.openai.api_key', OPENAI_API_KEY);
      const apiBaseUrl = await configGet<string>('audio.stt.openai.api_base_url', OPENAI_API_BASE_URL);
      const model = await configGet<string>('audio.stt.model', '');

      let lastDetail = 'Nelth-AI: Server Connection Error';
      let res: Response | null = null;
      try {
        res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}` },
          body: (() => {
            const fd = new FormData();
            fd.set('model', model);
            if (languageStr) fd.set('language', languageStr);
            fd.set('file', fileField, filename);
            return fd;
          })(),
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
        });
        if (!res.ok) {
          try {
            const body = await res.clone().json();
            if (body && typeof body === 'object' && 'error' in body) {
              const msg = (body as any).error;
              lastDetail = `External: ${typeof msg === 'object' && msg !== null ? (msg.message ?? msg) : msg}`;
            } else if (body && typeof body === 'object' && 'message' in body) {
              lastDetail = `External: ${(body as any).message}`;
            }
          } catch {
            // keep default detail
          }
        }
        const data = await res.json();
        return ctx.json({ ...data, filename });
      } catch (e) {
        // Python: _transcribe_openai raises a plain Exception which transcribe()
        // converts to HTTPException(500, f'Error transcribing chunk: {detail}').
        err(500, `Error transcribing chunk: ${lastDetail}`);
      }
    },
  },

  // ------------------- GET /models (user) -------------------
  {
    method: 'GET',
    path: 'models',
    auth: 'user',
    handler: async (ctx) => ctx.json({ models: await getAvailableModels() }),
  },

  // ------------------- GET /voices (user) -------------------
  {
    method: 'GET',
    path: 'voices',
    auth: 'user',
    handler: async (ctx) => {
      const voices = await getAvailableVoices();
      return ctx.json({ voices: Object.entries(voices).map(([id, name]) => ({ id, name })) });
    },
  },
];
