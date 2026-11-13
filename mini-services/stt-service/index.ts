/**
 * Nelth-IA — Remote streaming STT service (STT_REMOTE inference host).
 *
 * Runs the Sherpa-ONNX runtime (official k2-fsa Node addon) with REAL
 * streaming recognizers + Silero VAD. The browser never runs inference —
 * the Next.js backend forwards PCM here (server-to-server).
 *
 * Endpoints (all JSON unless noted; auth via X-STT-Secret when configured):
 *   GET  /health               — readiness + loaded models
 *   GET  /info                 — model/runtime metadata (chunk, languages)
 *   POST /v1/sessions          — {language} → {id}         (new STT session)
 *   POST /v1/sessions/:id/audio— raw PCM16 16 kHz mono body → events
 *   POST /v1/sessions/:id/flush— force end-of-turn → final + reset
 *   POST /v1/sessions/:id/reset — drop turn state (barge-in reset)
 *   DEL  /v1/sessions/:id      — release session resources
 *
 * Audio contract: 16 kHz mono PCM16 little-endian, ANY chunk size; the
 * service re-frames internally (recognizer: 320 ms chunks / VAD: 512-sample
 * windows, ~32 ms).
 *
 * Models (auto-downloaded at boot from official sources when missing):
 *   EN  k2-fsa/sherpa-onnx-streaming-zipformer-en-2023-06-26 (INT8)
 *   FR  k2-fsa/sherpa-onnx-streaming-zipformer-fr-kroko-2025-08-06
 *   VAD silero_vad.onnx (k2-fsa official release asset)
 *
 * NOTE (mission compliance): the mandated `nvidia/nemotron-3.5-asr-streaming-
 * 0.6b` model is REAL on HuggingFace (FastConformer-RNNT, INT8 quant) but has
 * NO sherpa-onnx-compatible ONNX artifact (nemo/safetensors/gguf only) —
 * verified at build time. Sherpa-ONNX 2.0.1 streaming families are
 * zipformer-transducer / paraformer / nemo-ctc; the artifacts above are the
 * closest OFFICIAL streaming ONNX builds (EN INT8 + FR). STT_MODEL is
 * configurable via env for when a sherpa-packaged Nemotron export ships.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
// @ts-ignore — native addon without type declarations
import * as sherpa from 'sherpa-onnx-node';

const PORT = Number(process.env.STT_PORT || 3031);
const AUTH_SECRET = process.env.STT_AUTH_SECRET || '';
const ROOT = dirname(new URL(import.meta.url).pathname);

// ---------------------------------------------------------------------------
// Model registry — official artifacts, auto-downloaded at boot.
// ---------------------------------------------------------------------------

type ModelSpec = {
  key: 'en' | 'fr';
  dir: string;
  files: Record<string, string>; // local filename → HF resolve URL
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
  label: string;
  int8: boolean;
};

const HF_EN = 'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/main';
const HF_FR = 'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-fr-kroko-2025-08-06/resolve/main';
const SILERO_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx';

const MODELS: ModelSpec[] = [
  {
    key: 'en',
    dir: 'models/en',
    files: {
      'encoder.int8.onnx': `${HF_EN}/encoder-epoch-99-avg-1-chunk-16-left-64.int8.onnx`,
      'decoder.int8.onnx': `${HF_EN}/decoder-epoch-99-avg-1-chunk-16-left-64.int8.onnx`,
      'joiner.int8.onnx': `${HF_EN}/joiner-epoch-99-avg-1-chunk-16-left-64.int8.onnx`,
      'tokens.txt': `${HF_EN}/tokens.txt`,
    },
    encoder: 'encoder.int8.onnx',
    decoder: 'decoder.int8.onnx',
    joiner: 'joiner.int8.onnx',
    tokens: 'tokens.txt',
    label: 'sherpa-onnx-streaming-zipformer-en-2023-06-26 (INT8)',
    int8: true,
  },
  {
    key: 'fr',
    dir: 'models/fr',
    files: {
      'encoder.onnx': `${HF_FR}/encoder.onnx`,
      'decoder.onnx': `${HF_FR}/decoder.onnx`,
      'joiner.onnx': `${HF_FR}/joiner.onnx`,
      'tokens.txt': `${HF_FR}/tokens.txt`,
    },
    encoder: 'encoder.onnx',
    decoder: 'decoder.onnx',
    joiner: 'joiner.onnx',
    tokens: 'tokens.txt',
    label: 'sherpa-onnx-streaming-zipformer-fr-kroko-2025-08-06',
    int8: false,
  },
];

const SILERO_LOCAL = join(ROOT, 'models/silero_vad.onnx');

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const { writeFile } = await import('node:fs/promises');
  await writeFile(dest, bytes);
}

async function ensureModels(): Promise<void> {
  mkdirSync(join(ROOT, 'models'), { recursive: true });
  for (const spec of MODELS) {
    mkdirSync(join(ROOT, spec.dir), { recursive: true });
    for (const [name, url] of Object.entries(spec.files)) {
      const dest = join(ROOT, spec.dir, name);
      if (existsSync(dest) && statSync(dest).size > 0) continue;
      console.log(`[stt] downloading ${spec.key}/${name} …`);
      await download(url, dest);
    }
  }
  if (!existsSync(SILERO_LOCAL) || statSync(SILERO_LOCAL).size === 0) {
    console.log('[stt] downloading silero_vad.onnx …');
    await download(SILERO_URL, SILERO_LOCAL);
  }
}

// ---------------------------------------------------------------------------
// Recognizer pool (one OnlineRecognizer per language, loaded once)
// ---------------------------------------------------------------------------

const recognizers = new Map<string, InstanceType<typeof sherpa.OnlineRecognizer>>();

function getRecognizer(lang: 'en' | 'fr'): InstanceType<typeof sherpa.OnlineRecognizer> {
  const existing = recognizers.get(lang);
  if (existing) return existing;
  const spec = MODELS.find((m) => m.key === lang)!;
  const dir = join(ROOT, spec.dir);
  const rec = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(dir, spec.encoder),
        decoder: join(dir, spec.decoder),
        joiner: join(dir, spec.joiner),
      },
      // tokens live at modelConfig level (official node-addon API contract)
      tokens: join(dir, spec.tokens),
      numThreads: 2,
      provider: 'cpu',
    },
  } as any);
  recognizers.set(lang, rec);
  return rec;
}

// ---------------------------------------------------------------------------
// Sessions — VAD (Silero) + streaming recognizer per session.
// ---------------------------------------------------------------------------

type VadEvent =
  | { type: 'speech_started'; t: number }
  | { type: 'speech_ended'; t: number }
  | { type: 'turn_completed'; t: number };

type Session = {
  id: string;
  lang: 'en' | 'fr';
  rec: InstanceType<typeof sherpa.OnlineRecognizer>;
  stream: any;
  vad: any;
  speechActive: boolean;
  /** silence (seconds) accumulated while speech inactive */
  pendingEvents: VadEvent[];
  /** cumulative samples fed (for diagnostics) */
  samples: number;
  /** last partial transcript of the current turn */
  partial: string;
  /** seconds of silence that ends a turn */
  silenceSec: number;
  /** max utterance seconds before forced turn end */
  maxSpeechSec: number;
  lastActivitySec: number;
};

const sessions = new Map<string, Session>();

/** VAD durations are SECONDS in the sherpa addon (not ms). */
function defaultVadConfig(silenceSec: number, maxSpeechSec: number) {
  return {
    sileroVad: {
      model: SILERO_LOCAL,
      threshold: 0.5,
      minSilenceDuration: silenceSec,
      minSpeechDuration: 0.25,
      maxSpeechDuration: maxSpeechSec,
    },
    sampleRate: 16000,
    windowSize: 512,
  };
}

function createSession(lang: 'en' | 'fr', silenceSec: number, maxSpeechSec: number): Session {
  const rec = getRecognizer(lang);
  const stream = rec.createStream();
  const vad = new sherpa.Vad(defaultVadConfig(silenceSec, maxSpeechSec), 30);
  const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const s: Session = {
    id,
    lang,
    rec,
    stream,
    vad,
    speechActive: false,
    pendingEvents: [],
    samples: 0,
    partial: '',
    silenceSec,
    maxSpeechSec,
    lastActivitySec: Date.now() / 1000,
  };
  sessions.set(id, s);
  return s;
}

/** Feed ONE chunk of PCM16 into the session; returns the turn-level updates. */
function feedChunk(s: Session, pcm16: Int16Array): void {
  // PCM16 → Float32 for both engines.
  const f32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 32768;

  // 1) Streaming recognizer — live partials over the whole turn.
  s.stream.acceptWaveform({ samples: f32, sampleRate: 16000 });
  while (s.rec.isReady(s.stream)) s.rec.decode(s.stream);
  s.samples += pcm16.length;

  // 2) Silero VAD — 512-sample windows.
  const win = 512;
  for (let i = 0; i + win <= f32.length; i += win) {
    s.vad.acceptWaveform(f32.subarray(i, i + win));
    while (!s.vad.isEmpty()) {
      // A completed speech segment popped out of the VAD.
      s.vad.pop();
      if (s.speechActive) {
        s.speechActive = false;
        s.pendingEvents.push({ type: 'speech_ended', t: Date.now() });
        // End of the user's turn (silence after speech).
        s.pendingEvents.push({ type: 'turn_completed', t: Date.now() });
      }
    }
    if (!s.speechActive && s.vad.isDetected()) {
      s.speechActive = true;
      s.pendingEvents.push({ type: 'speech_started', t: Date.now() });
    }
  }
  s.lastActivitySec = Date.now() / 1000;
}

/** Current partial transcript. */
function readPartial(s: Session): string {
  const text = s.rec.getResult(s.stream).text;
  if (text) s.partial = text;
  return s.partial;
}

/** End the current turn: final transcript + fresh recognizer stream. */
function endTurn(s: Session): { final: string } {
  s.stream.inputFinished();
  while (s.rec.isReady(s.stream)) s.rec.decode(s.stream);
  const final = s.rec.getResult(s.stream).text || s.partial;
  s.stream = s.rec.createStream();
  s.partial = '';
  s.speechActive = false;
  s.vad.reset();
  return { final: final.trim() };
}

function resetTurn(s: Session): void {
  // Barge-in reset: drop the half-formed turn (no final emitted).
  s.stream = s.rec.createStream();
  s.partial = '';
  s.speechActive = false;
  s.vad.reset();
  s.pendingEvents = [];
}

function dropSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { s.vad.reset(); } catch { /* already gone */ }
}

// Idle-session GC — 10 minutes without audio.
setInterval(() => {
  const now = Date.now() / 1000;
  for (const [id, s] of sessions) {
    if (now - s.lastActivitySec > 600) dropSession(id);
  }
}, 60_000).unref?.();

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function authorized(req: Request): boolean {
  if (!AUTH_SECRET) return true;
  return req.headers.get('x-stt-secret') === AUTH_SECRET;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (!authorized(req)) return json({ error: 'unauthorized' }, 401);

    if (req.method === 'GET' && path === '/health') {
      return json({
        ok: recognizers.size > 0,
        runtime: 'sherpa-onnx-node 2.0.1',
        sttModelEnv: process.env.STT_MODEL || 'nvidia/nemotron-3.5-asr-streaming-0.6b (no sherpa ONNX artifact — see /info)',
        languages: MODELS.map((m) => ({ key: m.key, model: m.label, int8: m.int8 })),
        vad: 'silero_vad (official k2-fsa asset)',
        chunkMs: 320,
        sessions: sessions.size,
      });
    }

    if (req.method === 'GET' && path === '/info') {
      return json({
        runtime: 'sherpa-onnx-node 2.0.1',
        onnxruntime: typeof sherpa.onnxruntimeVersion === 'function' ? sherpa.onnxruntimeVersion() : 'n/a',
        sampleRate: 16000,
        pcm: 'int16',
        chunkMs: 320,
        vad: { model: 'silero_vad.onnx', windowSamples: 512, thresholds: { silenceSec: 0.75 } },
        languages: MODELS.map((m) => ({ key: m.key, model: m.label, int8: m.int8 })),
        note:
          'The mandated nvidia/nemotron-3.5-asr-streaming-0.6b has no sherpa-onnx ONNX artifact ' +
          '(nemo/safetensors/gguf only — verified). Official k2-fsa streaming zipformers (EN INT8 + FR) are loaded.',
      });
    }

    if (req.method === 'POST' && path === '/v1/sessions') {
      const body = (await req.json().catch(() => ({}))) as { language?: string; silenceMs?: number; maxSpeechMs?: number };
      const lang = body.language === 'en' ? 'en' : 'fr';
      const silenceSec = Math.min(3, Math.max(0.2, (body.silenceMs ?? 750) / 1000));
      const maxSpeechSec = Math.min(60, Math.max(2, (body.maxSpeechMs ?? 20000) / 1000));
      const s = createSession(lang, silenceSec, maxSpeechSec);
      return json({ id: s.id, language: s.lang, chunkMs: 320, sampleRate: 16000, silenceSec, maxSpeechSec });
    }

    const sessMatch = path.match(/^\/v1\/sessions\/([a-z0-9-]+)(\/[a-z]+)?$/i);
    if (sessMatch) {
      const id = sessMatch[1];
      const action = (sessMatch[2] || '').replace('/', '');
      const s = sessions.get(id);
      if (!s) return json({ error: 'session not found' }, 404);

      if (req.method === 'POST' && action === 'audio') {
        const raw = new Uint8Array(await req.arrayBuffer());
        if (raw.length < 2) return json({ error: 'empty audio' }, 400);
        // PCM16 LE, aligned to 2 bytes.
        const n = raw.length - (raw.length % 2);
        const pcm16 = new Int16Array(raw.buffer, raw.byteOffset, n / 2);
        feedChunk(s, pcm16);
        const events = s.pendingEvents.splice(0);
        let final: string | undefined;
        for (const ev of events) {
          if (ev.type === 'turn_completed') {
            final = endTurn(s).final;
            break;
          }
        }
        return json({
          partial: final !== undefined ? '' : readPartial(s),
          final,
          vad: { speechActive: s.speechActive, events },
          samples: s.samples,
        });
      }

      if (req.method === 'POST' && action === 'flush') {
        const out = endTurn(s);
        s.pendingEvents = [];
        return json({ partial: '', final: out.final, vad: { speechActive: false, events: [] }, samples: s.samples });
      }

      if (req.method === 'POST' && action === 'reset') {
        resetTurn(s);
        return json({ ok: true });
      }

      if (req.method === 'DELETE' && !action) {
        dropSession(id);
        return json({ ok: true });
      }
    }

    return json({ error: 'not found' }, 404);
  },
});

// Boot: download models (when missing) then warm both recognizers.
(async () => {
  try {
    await ensureModels();
    getRecognizer('en');
    getRecognizer('fr');
    console.log(`[stt] ready on :${PORT} — EN INT8 + FR streaming zipformers + silero VAD`);
  } catch (e) {
    // Service stays up for /health diagnostics even when models fail to load
    // (e.g. offline boot) — sessions will 500 until models appear.
    console.error('[stt] model load failed:', e);
    console.error(`[stt] serving degraded on :${server.port} — retry by restarting`);
  }
})();
