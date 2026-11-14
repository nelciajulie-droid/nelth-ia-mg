/**
 * Built-in zero-config TTS/STT engines — standalone HTTP implementation.
 *
 * Open WebUI v0.12.5 ships local Whisper STT + local transformers TTS, so
 * voice features (mic input, read-aloud) work with zero configuration. This
 * port cannot bundle those Python pipelines; instead the same zero-config
 * behaviour is provided by plain HTTPS calls — no provider SDK involved,
 * the engine works on any host (local, Docker, bare metal):
 *
 *   • TTS — POST /api/v1/audio/speech with engine '' (default) speaks any
 *     text through the public Google Translate voice endpoint (keyless,
 *     MP3, every UI language). Long inputs are chunked at sentence
 *     boundaries and concatenated into one continuous MP3 track.
 *   • STT — POST /api/v1/audio/transcriptions with engine '' (default)
 *     transcribes uploaded audio through the free multimodal omni model of
 *     the Kilo AI Gateway (`nvidia/nemotron-3-nano-omni…:free`, reusing the
 *     existing KILO_GATEWAY_API_KEY). Browser mic captures (webm/opus) are
 *     transcoded to 16 kHz mono WAV via ffmpeg when available.
 *
 * Standalone deployments can instead configure any external engine
 * (openai / elevenlabs / azure / mistral / deepgram) from the admin audio
 * settings — the engine switch keeps original Python semantics.
 */

import { spawn } from 'node:child_process';
import { KILO_GATEWAY_BASE_URL, KILO_GATEWAY_API_KEY } from '@/lib/kilo-llm';

/**
 * Voices exposed by the built-in TTS engine — friendly keys mapping to
 * Google Translate language codes (surfaced in the audio settings).
 */
export const BUILTIN_TTS_VOICES: Record<string, string> = {
  french: 'fr',
  english: 'en',
  spanish: 'es',
  german: 'de',
  italian: 'it',
  portuguese: 'pt',
  dutch: 'nl',
  russian: 'ru',
  arabic: 'ar',
  chinese: 'zh-CN',
  japanese: 'ja',
  korean: 'ko',
};

/** Built-in TTS model id surfaced in the audio settings model list. */
export const BUILTIN_TTS_MODEL_ID = 'builtin-tts';

/** Built-in STT model id surfaced in the audio settings model list. */
export const BUILTIN_STT_MODEL_ID = 'builtin-asr';

/** Endpoint limit per Google TTS request (safe margin below ~200). */
const TTS_MAX_CHARS = 190;

/** Free multimodal gateway model used for zero-config transcription. */
const STT_MODEL =
  process.env.BUILTIN_STT_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';

// ---------------------------------------------------------------------------
// TTS — Google Translate voice endpoint (keyless MP3)
// ---------------------------------------------------------------------------

/**
 * Split long text into speakable chunks (sentence boundaries, hard cap).
 * Mirrors the chunking pattern the original applies for split_on=punctuation.
 */
function splitTextIntoChunks(text: string, maxLength = TTS_MAX_CHARS): string[] {
  const chunks: string[] = [];
  const sentences = text.match(/[^.!?…]+[.!?…]+[\s]|[^.!?…]+$/g) ?? [text];
  let current = '';
  const pushHardSplit = (sentence: string) => {
    let s = sentence;
    while (s.length > maxLength) {
      // Prefer cutting at a word boundary when possible.
      let cut = s.lastIndexOf(' ', maxLength);
      if (cut < maxLength * 0.5) cut = maxLength;
      chunks.push(s.slice(0, cut).trim());
      s = s.slice(cut);
    }
    return s;
  };
  for (const sentence of sentences) {
    if ((current + sentence).length <= maxLength) {
      current += sentence;
    } else {
      if (current.trim()) chunks.push(current.trim());
      current = pushHardSplit(sentence);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

function clampSpeed(speed: unknown): number {
  const n = typeof speed === 'number' ? speed : parseFloat(String(speed ?? ''));
  if (!Number.isFinite(n)) return 1.0;
  return Math.min(2.0, Math.max(0.5, n));
}

/**
 * Resolve the spoken language: an explicit built-in voice key, a raw
 * ISO language code, or auto-detection from the text itself.
 */
function normalizeVoice(voice: unknown, text: string): string {
  const v = typeof voice === 'string' ? voice.trim().toLowerCase() : '';
  if (v in BUILTIN_TTS_VOICES) return BUILTIN_TTS_VOICES[v];
  if (/^[a-z]{2}(-[a-z]{2})?$/i.test(v)) return v;
  // Auto-detect: accented Latin characters → French, otherwise English.
  return /[àâæçéèêëîïôœùûüÿ]/i.test(text) ? 'fr' : 'en';
}

export type SpokenAudio = { bytes: Buffer; contentType: string };

const TTS_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
  referer: 'https://translate.google.com/',
  accept: 'audio/mpeg, audio/*;q=0.9, */*;q=0.5',
};

/** Fetch one spoken MP3 chunk from the public voice endpoint (with retries). */
async function fetchTtsChunk(chunk: string, lang: string, idx: number, total: number): Promise<Buffer> {
  const params = new URLSearchParams({
    ie: 'UTF-8',
    q: chunk,
    tl: lang,
    client: 'tw-ob',
    idx: String(idx),
    total: String(total),
    textlen: String(chunk.length),
  });
  const url = `https://translate.google.com/translate_tts?${params}`;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 900 * attempt));
    try {
      const res = await fetch(url, { headers: TTS_HEADERS, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        lastError = new Error(`TTS endpoint HTTP ${res.status}`);
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      // Magic bytes: MPEG frame sync (0xFF Ex) or ID3 tag.
      const isMp3 =
        (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) ||
        (bytes.length > 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33);
      if (!isMp3 || bytes.length < 64) {
        lastError = new Error('TTS endpoint returned a non-audio body');
        continue;
      }
      return bytes;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Speech synthesis failed');
}

/**
 * Speak text through the built-in engine → concatenated MP3 bytes.
 * The public endpoint accepts ~200 characters per request, so long inputs
 * are chunked at sentence boundaries and the MP3 frames are concatenated
 * into one continuous track (browsers merge frames seamlessly).
 */
export async function ttsBuiltinSpeak(params: {
  input: string;
  voice?: string | null;
  speed?: number | string | null;
}): Promise<SpokenAudio> {
  const text = (params.input ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Text is required for speech synthesis');

  const lang = normalizeVoice(params.voice, text);
  void clampSpeed(params.speed); // validated & accepted — the keyless engine speaks at 1×
  const chunks = splitTextIntoChunks(text);

  const parts: Buffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    parts.push(await fetchTtsChunk(chunks[i], lang, i, chunks.length));
  }
  return { bytes: Buffer.concat(parts), contentType: 'audio/mpeg' };
}

// ---------------------------------------------------------------------------
// STT — free multimodal gateway model (chat completions with input_audio)
// ---------------------------------------------------------------------------

/** Detect the audio container from magic bytes. */
function detectAudioFormat(bytes: Buffer): string {
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') {
    return 'wav';
  }
  if (bytes.length >= 3 && bytes.toString('ascii', 0, 3) === 'ID3') return 'mp3';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3';
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'fLaC') return 'flac';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes.toString('ascii', 1, 4) === '\x00\x00\x00') {
    // EBML header → webm / matroska (browser MediaRecorder output).
    return 'webm';
  }
  if (bytes.length >= 8 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'webm';
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  return 'unknown';
}

/** Formats the gateway's input_audio schema accepts natively. */
const DIRECT_FORMATS = new Set(['wav', 'mp3', 'ogg', 'flac']);

/** Transcode arbitrary audio to 16 kHz mono WAV through ffmpeg (best effort). */
async function transcodeToWav(bytes: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-vn', '-ar', '16000', '-ac', '1',
        '-f', 'wav', 'pipe:1',
      ]);
    } catch {
      resolve(null);
      return;
    }
    const out: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout?.on('data', (d: Buffer) => out.push(d));
    proc.stderr?.on('data', (d: Buffer) => stderr.push(d));
    proc.on('error', () => resolve(null)); // ffmpeg not installed
    proc.on('close', (code) => {
      if (code === 0 && out.length > 44) resolve(Buffer.concat(out));
      else resolve(null);
    });
    proc.stdin?.on('error', () => {});
    proc.stdin?.end(bytes);
  });
}

/**
 * Transcribe audio bytes through the built-in engine → text.
 * Supported natively: WAV / MP3 / Ogg / FLAC. Other containers (webm from
 * the browser mic, m4a, mp4…) are transcoded to WAV via ffmpeg when the
 * binary is available on the host.
 */
export async function sttBuiltinTranscribe(file: {
  bytes: Buffer;
}): Promise<string> {
  if (!file.bytes?.length) throw new Error('Audio file is required for transcription');
  if (!KILO_GATEWAY_API_KEY) {
    throw new Error(
      'Built-in transcription requires KILO_GATEWAY_API_KEY (or configure an external STT engine in the admin audio settings)'
    );
  }

  let bytes = file.bytes;
  let format = detectAudioFormat(bytes);
  if (!DIRECT_FORMATS.has(format)) {
    const wav = await transcodeToWav(bytes);
    if (wav) {
      bytes = wav;
      format = 'wav';
    } else if (format === 'webm' || format === 'mp4' || format === 'unknown') {
      // ffmpeg absent — declare mp3 and hope the provider sniffs the container.
      format = 'mp3';
    }
  }

  const res = await fetch(`${KILO_GATEWAY_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KILO_GATEWAY_API_KEY}`,
    },
    body: JSON.stringify({
      model: STT_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Transcribe this audio verbatim. Reply with the transcription text only, no commentary.',
            },
            {
              type: 'input_audio',
              input_audio: { data: bytes.toString('base64'), format },
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Built-in transcription failed (HTTP ${res.status}): ${detail.slice(0, 200)}`);
  }
  const data: any = await res.json().catch(() => null);
  const content: unknown = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Empty transcription response');
  }
  // Some upstream errors come back as 200 with an error body — surface them.
  if (/^[\s\S]{0,40}(could not be decoded|Upstream error)/i.test(content)) {
    throw new Error(content.slice(0, 200));
  }
  return content.trim();
}
