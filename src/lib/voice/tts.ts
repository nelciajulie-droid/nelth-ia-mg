/**
 * TTS providers — server-side synthesis, per-sentence segments.
 *
 * PRIMARY (mandated §5): node-edge-tts — Microsoft Edge online TTS via
 * outbound WebSocket from the server; `streamAudio(text)` yields MP3
 * Buffers progressively (first audio leaves while the LLM still streams).
 * Each segment is a COMPLETE MP3 file → independently decodable in the
 * browser (mission §9).
 *
 * Fallback: the built-in z-ai SDK TTS (mp3, non-streaming per segment) —
 * used where Edge TTS rejects the host egress (this sandbox is IP-rate-
 * limited 429; Vercel egress is clean) or on provider failure, so the voice
 * experience still works end-to-end. Failures emit `tts.degraded` and the
 * assistant text always stays available (mission §19-F).
 */

import { EdgeTTS } from 'node-edge-tts';
import { VOICE_TTS_PROVIDER, VOICE_TTS_RATE, VOICE_TTS_PITCH } from './config';

export type TtsSegment = { audioBase64: string; bytes: number };

const EDGE_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

export class EdgeTtsProvider {
  readonly name = 'edge';
  private client: EdgeTTS | null = null;
  constructor(private voice: string, private rate = VOICE_TTS_RATE, private pitch = VOICE_TTS_PITCH) {}

  private ensure(): EdgeTTS {
    this.client ??= new EdgeTTS({
      voice: this.voice,
      outputFormat: EDGE_OUTPUT_FORMAT,
      rate: this.rate,
      pitch: this.pitch,
      timeout: 20_000,
    });
    return this.client;
  }

  /** Synthesize one sentence; streams progressive audio chunks out. */
  async *synthesize(text: string): AsyncGenerator<Buffer> {
    const tts = this.ensure();
    for await (const part of tts.streamAudio(text)) {
      if (Buffer.isBuffer(part) && part.length > 0) yield part;
    }
  }
}

export class ZaiTtsProvider {
  readonly name = 'zai';
  constructor(private voice = 'tongtong', private speed = 1.0) {}

  async *synthesize(text: string): AsyncGenerator<Buffer> {
    const ZAI = (await import('z-ai-web-dev-sdk')).default;
    const zai = await ZAI.create();
    const response = await zai.audio.tts.create({
      input: text.slice(0, 1024),
      voice: this.voice,
      speed: this.speed,
      response_format: 'mp3',
      stream: false,
    });
    const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
    if (buffer.length > 0) yield buffer;
  }
}

export type TtsProvider = EdgeTtsProvider | ZaiTtsProvider;

export function makeTtsProvider(providerName: string, voice: string, opts: { rate?: string; speed?: number } = {}): TtsProvider {
  if (providerName === 'zai') {
    const zaiVoice = voice.startsWith('zai:') ? voice.slice(4) : 'tongtong';
    return new ZaiTtsProvider(zaiVoice, opts.speed ?? 1.0);
  }
  return new EdgeTtsProvider(voice, opts.rate ?? VOICE_TTS_RATE);
}

export function bufferToBase64(buf: Buffer): string {
  return buf.toString('base64');
}
