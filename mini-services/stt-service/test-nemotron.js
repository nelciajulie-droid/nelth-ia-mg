/**
 * TEST — compatibility réelle de sherpa-onnx-node 2.0.1 avec le package
 * officiel k2-fsa nemotron-3.5-asr-streaming-0.6b (560ms INT8).
 *
 * Essaie les formes de config plausibles (nemotron / transducer), mesure le
 * temps de chargement, la RAM (RSS), le RTF et la transcription des WAV de
 * test officiels (fr/en).
 */
const path = require('node:path');
const fs = require('node:fs');
const sherpa = require('sherpa-onnx-node');

const DIR = path.join(__dirname, 'models', 'nemotron');
const ENC = path.join(DIR, 'encoder.int8.onnx');
const DEC = path.join(DIR, 'decoder.int8.onnx');
const JOI = path.join(DIR, 'joiner.int8.onnx');
const TOK = path.join(DIR, 'tokens.txt');
const WAVS = '/tmp/nemotron-pkg/test_wavs';

function rssMB() { return Math.round(process.memoryUsage().rss / 1048576); }

function tryLoad(name, modelConfig) {
  const t0 = Date.now();
  try {
    const rec = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: { ...modelConfig, tokens: TOK, numThreads: 2, provider: 'cpu' },
    });
    const ms = Date.now() - t0;
    console.log(`[${name}] LOADED in ${ms} ms — RSS=${rssMB()} MB`);
    return rec;
  } catch (e) {
    console.log(`[${name}] FAILED (${Date.now() - t0} ms): ${String(e).split('\n')[0].slice(0, 220)}`);
    return null;
  }
}

console.log('runtime', sherpa.version, '| RSS start', rssMB(), 'MB');

// Shape A: dedicated `nemotron` model config (newer sherpa-onnx C++ API).
const recA = tryLoad('nemotron-config', {
  nemotron: { encoder: ENC, decoder: DEC, joiner: JOI },
});

// Shape B: plain `transducer` (RNNT pathway).
const recB = recA || tryLoad('transducer-config', {
  transducer: { encoder: ENC, decoder: DEC, joiner: JOI },
});

const rec = recA || recB;
if (!rec) { console.log('NO COMPATIBLE CONFIG — addon 2.0.1 cannot load this package'); process.exit(2); }
const shape = recA ? 'nemotron' : 'transducer';
console.log('compatible shape =', shape, '| RSS after load', rssMB(), 'MB');

// Stream creation — with/without language argument.
function decodeWav(wavPath, language) {
  const w = sherpa.readWave(wavPath);
  const t0 = Date.now();
  const stream = rec.createStream();
  // newer API: per-stream language (nemotron prompts). Try if exposed.
  if (language && stream.setLanguage) {
    try { stream.setLanguage(language); } catch (e) { console.log('setLanguage failed:', String(e).slice(0, 120)); }
  }
  stream.acceptWaveform({ samples: w.samples, sampleRate: w.sampleRate });
  const tDecodeStart = Date.now();
  while (rec.isReady(stream)) rec.decode(stream);
  stream.inputFinished();
  while (rec.isReady(stream)) rec.decode(stream);
  const text = rec.getResult(stream).text;
  const dur = w.samples.length / w.sampleRate;
  const cpu = (Date.now() - tDecodeStart) / 1000;
  return { text, dur, cpu, rtf: cpu / dur };
}

for (const lang of ['fr', 'de', 'es']) {
  const wav = path.join(WAVS, `${lang}.wav`);
  if (!fs.existsSync(wav)) continue;
  const r = decodeWav(wav, lang);
  console.log(`[${lang}] dur=${r.dur.toFixed(2)}s cpu=${r.cpu.toFixed(2)}s RTF=${r.rtf.toFixed(3)} | text="${r.text.slice(0, 120)}"`);
}
console.log('RSS end', rssMB(), 'MB');
