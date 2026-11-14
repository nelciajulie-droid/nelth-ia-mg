/**
 * Voice audio engine (browser side) — microphone level meter + playback.
 *
 * CAPTURE (visualisation ONLY): getUserMedia (echoCancellation/
 * noiseSuppression/autoGain) → AudioWorklet energy detector → orb level
 * + local BARGE-IN VAD (user speech while the assistant speaks) →
 * interrupt endpoint. Speech recognition itself is handled by
 * @untemps/react-vocal (Web Speech API) — NO PCM ever leaves the browser.
 *
 * PLAYBACK: ordered queue of complete MP3 segments (each tts.audio_chunk
 * family shares one sequenceId; a segment is independently decodable).
 */

export type CaptureHandle = {
  context: AudioContext;
  stream: MediaStream;
  close: () => Promise<void>;
};

/** Injected into the AudioWorklet thread. */
const WORKLET_SRC = `
class PcmPublisher extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(1600); // 100 ms @ 16 kHz
    this.pos = 0;
    this.energy = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let peak = 0;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.frame[this.pos++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      const a = Math.abs(s); if (a > peak) peak = a;
      if (this.pos === this.frame.length) {
        this.port.postMessage({ pcm: this.frame.slice(0), peak }, [this.frame.buffer]);
        this.frame = new Int16Array(1600);
        this.pos = 0;
      }
    }
    if (peak > 0.045) this.port.postMessage({ tick: peak });
    return true;
  }
}
registerProcessor('pcm-publisher', PcmPublisher);
`;

export type CaptureEvents = {
  /** Fast RMS-ish indicator (0..1) — orb + local barge-in VAD. */
  onLevel: (level: number) => void;
};

export async function startCapture(evts: CaptureEvents): Promise<CaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true, // the assistant's speaker output must not
      noiseSuppression: true, // register as user speech (mission §10)
      autoGainControl: true,
    },
    video: false,
  });
  const context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
  const src = context.createMediaStreamSource(stream);
  const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  await context.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const node = new AudioWorkletNode(context, 'pcm-publisher', { numberOfOutputs: 0 });
  node.port.onmessage = (e) => {
    const data = e.data;
    if (typeof data.tick === 'number') evts.onLevel(data.tick);
  };
  src.connect(node); // worklet has 0 outputs → no speakers feedback
  return {
    context,
    stream,
    close: async () => {
      try { node.port.onmessage = null; node.disconnect(); src.disconnect(); } catch { /* gone */ }
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* gone */ }
      try { await context.close(); } catch { /* gone */ }
    },
  };
}

// ---------------------------------------------------------------------------
// Ordered MP3 segment playback
// ---------------------------------------------------------------------------

export type Segment = { sequenceId: number; blob: Blob };

export class PlaybackQueue {
  private queue: Segment[] = [];
  private audio: HTMLAudioElement | null = null;
  private currentSeq = 0;
  private stopped = false;
  private onSpeakingChange?: (speaking: boolean) => void;
  private completion: Promise<void> = Promise.resolve();
  private resolveCurrent: (() => void) | null = null;

  constructor(opts: { onSpeakingChange?: (speaking: boolean) => void } = {}) {
    this.onSpeakingChange = opts.onSpeakingChange;
  }

  get playing(): boolean {
    return !!this.audio && !this.audio.paused;
  }

  /** Add an audio chunk under a sequenceId (order enforced). */
  push(sequenceId: number, base64: string): void {
    if (sequenceId < this.currentSeq) return; // stale after interruption
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'audio/mpeg' });
    const existing = this.queue.find((s) => s.sequenceId === sequenceId);
    if (existing) {
      // Same segment, later chunk — mp3 chunks of ONE Edge TTS segment are
      // contiguous frames; concatenate and keep position.
      this.queue = this.queue.map((s) =>
        s.sequenceId === sequenceId ? { sequenceId, blob: new Blob([s.blob, blob], { type: 'audio/mpeg' }) } : s
      );
    } else {
      this.queue.push({ sequenceId, blob });
      this.queue.sort((a, b) => a.sequenceId - b.sequenceId);
      void this.drain();
    }
  }

  segmentDone(sequenceId: number): void {
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.stopped) return;
    if (this.audio && !this.audio.paused) return;
    const next = this.queue.shift();
    if (!next) {
      this.onSpeakingChange?.(false);
      return;
    }
    this.currentSeq = next.sequenceId;
    this.onSpeakingChange?.(true);
    const url = URL.createObjectURL(next.blob);
    const audio = new Audio(url);
    audio.setAttribute('playsinline', 'true');
    this.audio = audio;
    this.completion = new Promise<void>((resolve) => {
      this.resolveCurrent = resolve;
      const finish = () => {
        URL.revokeObjectURL(url);
        this.resolveCurrent = null;
        resolve();
        void this.drain();
      };
      audio.onended = finish;
      audio.onerror = finish;
    });
    try {
      await audio.play();
    } catch {
      /* autoplay policy — the session started from a click, rare */
      this.resolveCurrent?.();
    }
  }

  /** Stop NOW (barge-in): drop everything, reject stale sequences. */
  stop(): void {
    this.stopped = true;
    const a = this.audio;
    this.audio = null;
    if (a) {
      a.onended = null;
      a.onerror = null;
      a.pause();
      a.src = '';
    }
    this.queue = [];
    this.currentSeq = Number.MAX_SAFE_INTEGER; // reject all stale pushes
    this.onSpeakingChange?.(false);
    this.resolveCurrent?.();
  }

  /** Re-arm after an interruption (next assistant turn). */
  resume(): void {
    this.stopped = false;
    this.currentSeq = 0;
  }

  /** Wait until the queue is fully played (end of turn UI sync). */
  wait(): Promise<void> {
    return this.completion.then(() => {
      while (this.audio && !this.audio.paused) { /* fallthrough */ break; }
      return this.completion;
    });
  }
}
