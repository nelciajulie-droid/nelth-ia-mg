/**
 * BENCHMARK comparatif — Nemotron 3.5 ASR (560ms INT8, package officiel
 * k2-fsa) vs Zipformer FR kroko + Zipformer EN INT8.
 *
 * Mesures (machine réelle, 2 cœurs) : temps de chargement, RSS, RTF,
 * exactitude sur les WAV officiels, langue par flux (setOption).
 */
const path = require('node:path');
const fs = require('node:fs');
const sherpa = require('sherpa-onnx-node');

const WAVS = '/tmp/nemotron-pkg/test_wavs';
const NEMO = path.join(__dirname, 'models', 'nemotron');
const EN = path.join(__dirname, 'models', 'en');
const FR = path.join(__dirname, 'models', 'fr');
const SILERO = path.join(__dirname, 'models', 'silero_vad.onnx');

function rssMB() { return Math.round(process.memoryUsage().rss / 1048576); }
function bench(label, buildRec, tests) {
  const t0 = Date.now();
  const rec = buildRec();
  const loadMs = Date.now() - t0;
  const ram = rssMB();
  const out = { label, loadMs, ramMB: ram, tests: [] };
  for (const { wav, lang } of tests) {
    if (!fs.existsSync(wav)) { out.tests.push({ wav, skip: true }); continue; }
    const w = sherpa.readWave(wav);
    const stream = rec.createStream();
    if (lang) { try { stream.setOption('language', lang); } catch { /* no-op */ } }
    const t1 = Date.now();
    stream.acceptWaveform({ samples: w.samples, sampleRate: w.sampleRate });
    while (rec.isReady(stream)) rec.decode(stream);
    stream.inputFinished();
    while (rec.isReady(stream)) rec.decode(stream);
    const text = rec.getResult(stream).text;
    const dur = w.samples.length / w.sampleRate;
    const cpu = (Date.now() - t1) / 1000;
    out.tests.push({ wav: path.basename(wav), lang: lang || 'auto', durSec: +dur.toFixed(2), cpuSec: +cpu.toFixed(2), rtf: +(cpu / dur).toFixed(3), text: text.slice(0, 130) });
  }
  return out;
}

const results = [];

// --- Nemotron (transducer pathway + per-stream language) ---
results.push(bench('nemotron-3.5-asr-streaming-0.6b 560ms INT8', () => new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { transducer: { encoder: path.join(NEMO, 'encoder.int8.onnx'), decoder: path.join(NEMO, 'decoder.int8.onnx'), joiner: path.join(NEMO, 'joiner.int8.onnx') }, tokens: path.join(NEMO, 'tokens.txt'), numThreads: 2, provider: 'cpu' },
}), [
  { wav: `${WAVS}/fr.wav`, lang: 'fr' },
  { wav: `${WAVS}/fr.wav`, lang: null },
  { wav: `${WAVS}/en.wav`, lang: 'en' },
  { wav: `${WAVS}/de.wav`, lang: 'de' },
]));

// --- Zipformer FR kroko ---
results.push(bench('zipformer-fr-kroko-2025-08-06 (fp32)', () => new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { transducer: { encoder: path.join(FR, 'encoder.onnx'), decoder: path.join(FR, 'decoder.onnx'), joiner: path.join(FR, 'joiner.onnx') }, tokens: path.join(FR, 'tokens.txt'), numThreads: 2, provider: 'cpu' },
}), [
  { wav: `${WAVS}/fr.wav`, lang: null },
]));

// --- Zipformer EN INT8 ---
results.push(bench('zipformer-en-2023-06-26 (INT8)', () => new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { transducer: { encoder: path.join(EN, 'encoder.int8.onnx'), decoder: path.join(EN, 'decoder.int8.onnx'), joiner: path.join(EN, 'joiner.int8.onnx') }, tokens: path.join(EN, 'tokens.txt'), numThreads: 2, provider: 'cpu' },
}), [
  { wav: `${WAVS}/en.wav`, lang: null },
]));

// --- Silero VAD RAM/load ---
const tv = Date.now();
const vad = new sherpa.Vad({ sileroVad: { model: SILERO, threshold: 0.5, minSilenceDuration: 0.75, minSpeechDuration: 0.25, maxSpeechDuration: 20 }, sampleRate: 16000, windowSize: 512 }, 30);
console.log(JSON.stringify({ vadLoadMs: Date.now() - tv, rssAfterVad: rssMB() }, null, 0));

console.log(JSON.stringify(results, null, 1));
