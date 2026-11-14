/**
 * TTS providers — server-side synthesis, per-sentence segments.
 *
 * SOLE PROVIDER (mandated §5): node-edge-tts — Microsoft Edge online TTS via
 * outbound WebSocket from the server; `streamAudio(text)` yields MP3
 * Buffers progressively (first audio leaves while the LLM still streams).
 * Each segment is a COMPLETE MP3 file → independently decodable in the
 * browser (mission §9).
 *
 * NO fallback provider: on Edge TTS failure the failure is reported
 * (`tts.degraded` / `session.error`) and the assistant text always stays
 * available (mission §19-F) — the app NEVER silently routes to another
 * provider.
 */

import { EdgeTTS } from 'node-edge-tts';
import { VOICE_TTS_RATE, VOICE_TTS_PITCH } from './config';

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

export type TtsProvider = EdgeTtsProvider;

export function makeTtsProvider(providerName: string, voice: string, opts: { rate?: string; speed?: number } = {}): TtsProvider {
  // Edge TTS is the ONLY provider — any other value falls back to it.
  void providerName;
  return new EdgeTtsProvider(voice, opts.rate ?? VOICE_TTS_RATE);
}

export function bufferToBase64(buf: Buffer): string {
  return buf.toString('base64');
}
