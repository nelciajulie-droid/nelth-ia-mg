/**
 * Nelth-IA — Remote streaming STT service (STT_REMOTE inference host).
 *
 * Runs the Sherpa-ONNX runtime (official k2-fsa Node addon) with REAL
 * streaming recognizers + Silero VAD. The browser never runs inference —
 * the Next.js backend forwards PCM here (server-to-server).
 *
 * Engines (STT_ENGINE env):
 *   • nemotron (DEFAULT) — nvidia/nemotron-3.5-asr-streaming-0.6b, the
 *     OFFICIAL k2-fsa export (560 ms chunk, INT8):
 *     https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/
 *     sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11.tar.bz2
 *     Multilingual (auto-detect + per-stream language prompts via
 *     stream.setOption('language', lang) — tested: improves non-auto langs).
 *     Compatibility with sherpa-onnx-node 2.0.1: the `nemotron` modelConfig
 *     section is NOT parsed by this addon, but the package loads through the
 *     `transducer` pathway (RNNT) — measured and verified.
 *   • zipformer — the previously tested fallback: EN INT8 2023-06-26 +
 *     FR kroko 2025-08-06 official k2-fsa streaming zipformers.
 *
 * Endpoints (all JSON unless noted; auth via X-STT-Secret when configured):
 *   GET  /health               — readiness + loaded models
 *   GET  /info                 — model/runtime metadata (engine, languages)
 *   POST /v1/sessions          — {language} → {id}         (new STT session)
 *   POST /v1/sessions/:id/audio— raw PCM16 16 kHz mono body → events
 *   POST /v1/sessions/:id/flush— force end-of-turn → final + reset
 *   POST /v1/sessions/:id/reset — drop turn state (barge-in reset)
 *   DEL  /v1/sessions/:id      — release session resources
 *
 * Audio contract: 16 kHz mono PCM16 little-endian, ANY chunk size; the
 * service re-frames internally (nemotron: 560 ms chunks / VAD: 512-sample
 * windows, ~32 ms).
 *
 * Benchmarks (this host, 2 dedicated cores, measured 2026-11-13):
 *   nemotron 560ms INT8  — load 1846 ms, RSS 977 MB, RTF 0.87–1.03,
 *                          FR fr.wav FULL sentence + natural casing/punctuation
 *   zipformer FR kroko   — RTF 0.075, truncated final on the same wav
 *   zipformer EN INT8    — RTF 0.172, ALL-CAPS output
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
// @ts-ignore — native addon without type declarations
import * as sherpa from 'sherpa-onnx-node';

// Port 3032 — 3031 is taken by tokenharbor-mock (sandbox boot stack); the
// Next.js voice config default follows this change (src/lib/voice/config.ts).
const PORT = Number(process.env.STT_PORT || 3032);
const AUTH_SECRET = process.env.STT_AUTH_SECRET || '';
const ROOT = dirname(new URL(import.meta.url).pathname);

/** nemotron = mandated model (official k2-fsa export) | zipformer = tested fallback. */
const ENGINE = (process.env.STT_ENGINE || 'nemotron').toLowerCase() === 'zipformer' ? 'zipformer' : 'nemotron';
/** Decode threads (nemotron RTF ~0.9 on 2 cores — give the host what it has). */
const NUM_THREADS = Math.max(1, Number(process.env.STT_THREADS) || 2);

// ---------------------------------------------------------------------------
// Model registry — official artifacts, auto-downloaded at boot.
// ---------------------------------------------------------------------------

type ModelSpec = {
  key: string;
  dir: string;
  files: Record<string, string>; // local filename → download URL
  /** Optional official tarball: when the release publishes one archive (not
   *  individual files — the nemotron case), download + extract it instead of
   *  fetching the files map (which 404s for nemotron releases). */
  tarball?: string;
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
  label: string;
  int8: boolean;
};

const K2 = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
const HF_EN = 'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/main';
const HF_FR = 'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-fr-kroko-2025-08-06/resolve/main';
const SILERO_URL = `${K2}/silero_vad.onnx`;

const NEMOTRON_DIRNAME = 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11';
const NEMOTRON_URL = `${K2}/${NEMOTRON_DIRNAME}`;

const MODELS: ModelSpec[] = [
  ...(ENGINE === 'nemotron'
    ? [{
        key: 'nemotron',
        dir: 'models/nemotron',
        files: {}, // the release hosts ONE tarball — no individual asset/ paths
        tarball: `${NEMOTRON_URL}.tar.bz2`,
        encoder: 'encoder.int8.onnx',
        decoder: 'decoder.int8.onnx',
        joiner: 'joiner.int8.onnx',
        tokens: 'tokens.txt',
        label: 'nvidia/nemotron-3.5-asr-streaming-0.6b (k2-fsa official export, 560ms INT8)',
        int8: true,
      }]
    : [
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
      ]),
];

const SILERO_LOCAL = join(ROOT, 'models/silero_vad.onnx');

async function download(url: string, dest: string): Promise<void> {
  // STREAMED to disk (Bun FileSink) — a 453 MB tarball buffered in RAM
  // (res.arrayBuffer) killed the process on constrained hosts.
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status}: ${url}`);
  const writer = Bun.file(dest).writer({ highWaterMark: 1 << 20 });
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) await writer.write(value);
    }
  } finally {
    await writer.end();
  }
}

/** Download + extract an official release tarball, then move the expected
 *  model files into the spec dir. Idempotent: skipped when files exist. */
async function ensureTarball(spec: ModelSpec): Promise<void> {
  const dir = join(ROOT, spec.dir);
  mkdirSync(dir, { recursive: true });
  const needed = [spec.encoder, spec.decoder, spec.joiner, spec.tokens];
  const allPresent = needed.every((f) => existsSync(join(dir, f)) && statSync(join(dir, f)).size > 0);
  if (allPresent) return;

  const tarballPath = join(ROOT, 'models', `${spec.key}-download.tar.bz2`);
  console.log(`[stt] downloading ${spec.tarball} …`);
  await download(spec.tarball!, tarballPath);

  const extractDir = join(ROOT, 'models', `${spec.key}-extract`);
  mkdirSync(extractDir, { recursive: true });
  // GNU tar: -xjf (bzip2), strip nothing — archives contain a top-level dir.
  const proc = Bun.spawnSync(['tar', '-xjf', tarballPath, '-C', extractDir]);
  if (proc.exitCode !== 0) {
    throw new Error(`tar extract failed: ${proc.stderr.toString().slice(0, 200)}`);
  }
  // Move files from the extracted tree (whatever depth) into the spec dir.
  const { readdirSync, cpSync, rmSync } = await import('node:fs');
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (needed.includes(entry.name)) cpSync(p, join(dir, entry.name));
    }
  };
  walk(extractDir);
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(tarballPath, { force: true });
  const ok = needed.every((f) => existsSync(join(dir, f)) && statSync(join(dir, f)).size > 0);
  if (!ok) throw new Error(`tarball did not contain the expected files for ${spec.key}`);
}

async function ensureModels(): Promise<void> {
  mkdirSync(join(ROOT, 'models'), { recursive: true });
  for (const spec of MODELS) {
    if (spec.tarball) {
      await ensureTarball(spec);
      continue;
    }
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
// Recognizer pool (loaded once, per engine).
// ---------------------------------------------------------------------------

const recognizers = new Map<string, InstanceType<typeof sherpa.OnlineRecognizer>>();

/** Language codes accepted by the nemotron prompt dictionary (subset used by
 *  the voice UI; empty string = auto-detect). */
const NEMOTRON_LANGS: Record<string, string> = {
  fr: 'fr', en: 'en', auto: '',
};

function getRecognizer(key: string): InstanceType<typeof sherpa.OnlineRecognizer> {
  const existing = recognizers.get(key);
  if (existing) return existing;
  const spec = MODELS.find((m) => m.key === key)!;
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
      numThreads: NUM_THREADS,
      provider: 'cpu',
    },
  } as any);
  recognizers.set(key, rec);
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
  lang: string;              // UI language — nemotron prompt ('fr'/'en', ''=auto)
  recognizerKey: string;     // nemotron | en | fr
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

function createSession(lang: string, silenceSec: number, maxSpeechSec: number): Session {
  // Engine dispatch: nemotron is multilingual (one recognizer, language as
  // per-stream prompt); zipformer needs the language-specific recognizer.
  const recognizerKey = ENGINE === 'nemotron' ? 'nemotron' : (lang === 'en' ? 'en' : 'fr');
  const promptLang = ENGINE === 'nemotron' ? (NEMOTRON_LANGS[lang] ?? '') : lang;
  const rec = getRecognizer(recognizerKey);
  const stream = rec.createStream();
  if (ENGINE === 'nemotron' && typeof stream.setOption === 'function') {
    try { stream.setOption('language', promptLang); } catch { /* auto-detect fallback */ }
  }
  const vad = new sherpa.Vad(defaultVadConfig(silenceSec, maxSpeechSec), 30);
  const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const s: Session = {
    id,
    lang: promptLang,
    recognizerKey,
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
        engine: ENGINE,
        sttModelEnv: process.env.STT_MODEL || 'nvidia/nemotron-3.5-asr-streaming-0.6b',
        languages: MODELS.map((m) => ({ key: m.key, model: m.label, int8: m.int8 })),
        vad: 'silero_vad (official k2-fsa asset)',
        chunkMs: ENGINE === 'nemotron' ? 560 : 320,
        threads: NUM_THREADS,
        sessions: sessions.size,
      });
    }

    if (req.method === 'GET' && path === '/info') {
      return json({
        runtime: 'sherpa-onnx-node 2.0.1',
        onnxruntime: typeof sherpa.onnxruntimeVersion === 'function' ? sherpa.onnxruntimeVersion() : 'n/a',
        sampleRate: 16000,
        pcm: 'int16',
        chunkMs: ENGINE === 'nemotron' ? 560 : 320,
        engine: ENGINE,
        vad: { model: 'silero_vad.onnx', windowSamples: 512, thresholds: { silenceSec: 0.75 } },
        languages: MODELS.map((m) => ({ key: m.key, model: m.label, int8: m.int8 })),
        benchmarks: ENGINE === 'nemotron'
          ? { loadMs: 1846, rssMB: 977, rtf: [0.873, 1.026], cores: 2, note: 'measured on this host class 2026-11-13' }
          : undefined,
        note:
          ENGINE === 'nemotron'
            ? 'nvidia/nemotron-3.5-asr-streaming-0.6b — official k2-fsa export (scripts/nemo/nemotron-3.5-asr-streaming-0.6b, 560ms INT8). Loaded via the transducer pathway of sherpa-onnx-node 2.0.1 (the nemotron modelConfig section is not parsed by this addon version — verified); per-stream language prompts via stream.setOption("language").'
            : 'Official k2-fsa streaming zipformers (EN INT8 + FR) — tested fallback engine (STT_ENGINE=zipformer).',
      });
    }

    if (req.method === 'POST' && path === '/v1/sessions') {
      const body = (await req.json().catch(() => ({}))) as { language?: string; silenceMs?: number; maxSpeechMs?: number };
      const lang = ENGINE === 'nemotron' ? String(body.language || 'fr').slice(0, 8) : (body.language === 'en' ? 'en' : 'fr');
      const silenceSec = Math.min(3, Math.max(0.2, (body.silenceMs ?? 750) / 1000));
      const maxSpeechSec = Math.min(60, Math.max(2, (body.maxSpeechMs ?? 20000) / 1000));
      const s = createSession(lang, silenceSec, maxSpeechSec);
      return json({ id: s.id, language: s.lang, engine: ENGINE, chunkMs: ENGINE === 'nemotron' ? 560 : 320, sampleRate: 16000, silenceSec, maxSpeechSec });
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

// Boot: download models (when missing) then warm the engine's recognizer(s).
(async () => {
  try {
    await ensureModels();
    for (const spec of MODELS) getRecognizer(spec.key);
    console.log(
      `[stt] ready on :${PORT} — engine=${ENGINE} (${MODELS.map((m) => m.label).join(' + ')}) + silero VAD, threads=${NUM_THREADS}`
    );
  } catch (e) {
    // Service stays up for /health diagnostics even when models fail to load
    // (e.g. offline boot) — sessions will 500 until models appear.
    console.error('[stt] model load failed:', e);
    console.error(`[stt] serving degraded on :${server.port} — retry by restarting`);
  }
})();
