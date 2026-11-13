/**
 * VoiceApp — the real-time voice conversation overlay (orb-ui Orb).
 *
 * States: idle → connecting → listening ⇄ thinking ⇄ speaking (full duplex,
 * the microphone NEVER stops) — interruption at any moment.
 * Sidebar stays visible (bridge mounts in the center region); mobile gets
 * an X button to return to the chat.
 */

import * as React from 'react';
import { Orb } from 'orb-ui';
import {
  Mic, MicOff, PhoneOff, Gauge, RotateCcw, X, Volume2, VolumeX, Loader2, AlertTriangle,
} from 'lucide-react';
import type { VoiceEvent } from '@/lib/voice/protocol';
import { PlaybackQueue, startCapture, type CaptureHandle } from './audio';
import { createSession, openEventStream, postAudio, postInterrupt, postEnd, fetchCatalogue, type SessionInfo, type VoiceCatalogue } from './api';

type OrbState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

type Props = {
  chatId: string | null;
  onClose?: () => void;
};

const STATE_LABELS: Record<OrbState, string> = {
  idle: 'Prêt',
  connecting: 'Connexion…',
  listening: 'Je vous écoute',
  thinking: 'Réflexion…',
  speaking: 'Je vous réponds',
  error: 'Erreur',
};

export function VoiceApp({ chatId, onClose }: Props) {
  const [phase, setPhase] = React.useState<'boot' | 'requesting-mic' | 'live' | 'ended'>('boot');
  const [orbState, setOrbState] = React.useState<OrbState>('idle');
  const [level, setLevel] = React.useState(0);
  const [partial, setPartial] = React.useState('');
  const [answer, setAnswer] = React.useState('');
  const [streamingAnswer, setStreamingAnswer] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [micError, setMicError] = React.useState<string | null>(null);
  const [muted, setMuted] = React.useState(false);
  const [catalogue, setCatalogue] = React.useState<VoiceCatalogue | null>(null);
  const [language, setLanguage] = React.useState<'fr' | 'en'>('fr');
  const [voiceId, setVoiceId] = React.useState<string>('');
  const [speed, setSpeed] = React.useState(1);
  const [interruptedCount, setInterruptedCount] = React.useState(0);

  const sessionRef = React.useRef<SessionInfo | null>(null);
  const captureRef = React.useRef<CaptureHandle | null>(null);
  const eventsRef = React.useRef<{ close: () => void } | null>(null);
  const playbackRef = React.useRef<PlaybackQueue | null>(null);
  const mutedRef = React.useRef(false);
  const liveRef = React.useRef(false);
  const speakingRef = React.useRef(false);
  const [speaking, setSpeaking] = React.useState(false);
  const answerRef = React.useRef('');
  const localVadRef = React.useRef({ above: 0 });
  const retryRef = React.useRef<(() => void) | null>(null);

  // -----------------------------------------------------------------------
  // Local barge-in VAD (lightweight signal processing ONLY — no inference):
  // sustained mic energy while the assistant speaks → interrupt.
  // -----------------------------------------------------------------------
  const handleLevel = React.useCallback((lvl: number) => {
    setLevel((prev) => Math.max(prev * 0.72, Math.min(1, lvl * 1.6)));
    if (!liveRef.current || !speakingRef.current) {
      localVadRef.current.above = 0;
      return;
    }
    if (lvl > 0.085) {
      localVadRef.current.above += 1;
      if (localVadRef.current.above >= 3) {
        // ~300 ms of speech during playback → barge-in.
        localVadRef.current.above = 0;
        const sid = sessionRef.current?.sessionId;
        if (sid) void postInterrupt(sid);
      }
    } else {
      localVadRef.current.above = Math.max(0, localVadRef.current.above - 1);
    }
  }, []);

  const handleFrame = React.useCallback((pcm: Int16Array) => {
    if (!mutedRef.current) {
      const sid = sessionRef.current?.sessionId;
      if (sid) void postAudio(sid, pcm);
    }
  }, []);

  // -----------------------------------------------------------------------
  // Event channel
  // -----------------------------------------------------------------------
  const onEvent = React.useCallback((ev: VoiceEvent) => {
    const p = (ev as any).payload;
    switch (ev.type) {
      case 'vad.speech_started':
        setOrbState((s) => (s === 'listening' ? 'listening' : s));
        break;
      case 'stt.partial':
        setPartial(String(p?.text ?? ''));
        break;
      case 'stt.final':
        setPartial('');
        setAnswer(String(p?.text ?? ''));
        answerRef.current = '';
        setOrbState('thinking');
        break;
      case 'llm.started':
        setStreamingAnswer('');
        setOrbState('thinking');
        break;
      case 'llm.token':
        answerRef.current += String(p?.text ?? '');
        setStreamingAnswer(answerRef.current);
        break;
      case 'tts.started':
        setOrbState('speaking');
        speakingRef.current = true;
        setSpeaking(true);
        playbackRef.current?.resume();
        break;
      case 'tts.audio_chunk':
        playbackRef.current?.push(Number(p?.sequenceId), String(p?.audioBase64 ?? ''));
        break;
      case 'tts.segment_completed':
        playbackRef.current?.segmentDone(Number(p?.sequenceId));
        break;
      case 'tts.degraded':
        setError(`Audio de repli activé (${String(p?.reason ?? '')})`);
        break;
      case 'vad.interruption_detected':
      case 'assistant.interrupted':
        playbackRef.current?.stop();
        speakingRef.current = false;
        setSpeaking(false);
        setInterruptedCount((n) => n + 1);
        setOrbState('listening');
        break;
      case 'assistant.finished':
        setStreamingAnswer('');
        setAnswer(String(p?.text ?? ''));
        speakingRef.current = false;
        setSpeaking(false);
        setOrbState('listening');
        if (p?.chatId && sessionRef.current) sessionRef.current.chatId = String(p.chatId);
        break;
      case 'session.error': {
        const msg = String(p?.message ?? 'Erreur');
        setError(msg);
        if (!p?.recoverable) setOrbState('error');
        break;
      }
      case 'session.ended':
        setPhase('ended');
        liveRef.current = false;
        break;
    }
  }, []);

  // -----------------------------------------------------------------------
  // Start / stop
  // -----------------------------------------------------------------------
  const start = React.useCallback(async () => {
    setError(null);
    setMicError(null);
    setOrbState('connecting');
    try {
      const cat = catalogue ?? (await fetchCatalogue());
      setCatalogue(cat);
      const lang = (cat.defaultLanguage === 'en' ? 'en' : 'fr') as 'fr' | 'en';
      setLanguage(lang);
      setVoiceId((v) => v || cat.voices.find((x) => x.language === lang)?.id || cat.voices[0]?.id || '');

      setPhase('requesting-mic');
      const capture = await startCapture({ onFrame: handleFrame, onLevel: handleLevel });
      captureRef.current = capture;

      const session = await createSession({ language: lang, voice: voiceId || undefined, speed, chatId });
      sessionRef.current = session;

      playbackRef.current = new PlaybackQueue({ onSpeakingChange: (sp) => { if (!sp) setTimeout(() => setOrbState((s) => (s === 'speaking' ? 'listening' : s)), 80); } });

      eventsRef.current = openEventStream(session.sessionId, onEvent);
      liveRef.current = true;
      setPhase('live');
      setOrbState('listening');
    } catch (e: any) {
      setOrbState('error');
      const msg = e?.message ?? String(e);
      if (/permission|denied|notallowed/i.test(msg)) setMicError('Micro refusé — autorisez le microphone dans votre navigateur.');
      else if (/notfound/i.test(msg)) setMicError('Aucun micro détecté sur cet appareil.');
      else setError(msg);
      captureRef.current?.close();
      captureRef.current = null;
    }
  }, [catalogue, voiceId, speed, chatId, handleFrame, handleLevel, onEvent]);

  React.useEffect(() => {
    retryRef.current = start;
  }, [start]);

  const stop = React.useCallback(async () => {
    liveRef.current = false;
    eventsRef.current?.close();
    eventsRef.current = null;
    playbackRef.current?.stop();
    speakingRef.current = false;
    const sid = sessionRef.current?.sessionId;
    if (sid) await postEnd(sid).catch(() => undefined);
    await captureRef.current?.close();
    captureRef.current = null;
    setPhase('ended');
    setOrbState('idle');
    setLevel(0);
  }, []);

  React.useEffect(() => {
    void start();
    return () => {
      liveRef.current = false;
      eventsRef.current?.close();
      playbackRef.current?.stop();
      captureRef.current?.close();
    };
  }, []);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    mutedRef.current = next;
  };

  const stopSpeaking = () => {
    const sid = sessionRef.current?.sessionId;
    if (sid) void postInterrupt(sid);
    playbackRef.current?.stop();
    speakingRef.current = false;
    setOrbState('listening');
  };

  const restart = () => {
    void (async () => {
      await stop();
      setPartial(''); setAnswer(''); setStreamingAnswer(''); setError(null); setInterruptedCount(0);
      void start();
    })();
  };

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  const isLive = phase === 'live';
  const voices = catalogue?.voices.filter((v) => v.language === language) ?? [];

  return (
    <div className="vv-root" data-phase={phase}>
      {/* Header — mobile X returns to the chat; desktop keeps controls */}
      <div className="vv-header">
        <div className="vv-header-title">
          <span className="vv-live-dot" data-on={isLive} aria-hidden />
          <span>{isLive ? 'Conversation vocale' : phase === 'boot' || phase === 'requesting-mic' ? 'Démarrage…' : 'Session terminée'}</span>
        </div>
        <button type="button" className="vv-x" onClick={() => { void stop(); onClose?.(); }} aria-label="Retour au chat">
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className="vv-body">
        {/* Orb — voice state visualization (CPU-cheap canvas) */}
        <div className="vv-orb-wrap">
          <Orb state={orbState} theme="cloud" signal={{ state: orbState, inputVolume: level * (muted ? 0 : 1), outputVolume: speaking ? 0.6 : 0 }} />
        </div>

        <div className="vv-state" data-state={orbState}>
          {phase === 'requesting-mic' ? (
            <span className="vv-state-line"><Loader2 className="size-3.5 animate-spin" aria-hidden /> Microphone…</span>
          ) : (
            STATE_LABELS[orbState]
          )}
          {interruptedCount > 0 && isLive ? <span className="vv-interrupted"> · {interruptedCount} interruption{interruptedCount > 1 ? 's' : ''}</span> : null}
        </div>

        {/* Live transcript */}
        <div className="vv-transcript" role="log" aria-live="polite">
          <div className="vv-partial" data-empty={!partial}>{partial || (orbState === 'listening' ? 'Parlez…' : ' ')}</div>
          {(answer || streamingAnswer) && (
            <div className="vv-answer">
              <span className="vv-answer-user">{answer}</span>
              {streamingAnswer && <span className="vv-answer-stream">{streamingAnswer}<span className="vv-caret" aria-hidden /></span>}
            </div>
          )}
        </div>

        {(micError || error) && (
          <div className="vv-error" role="alert">
            <AlertTriangle className="size-4 shrink-0" aria-hidden />
            <span>{micError ?? error}</span>
            {(micError || !isLive) && (
              <button type="button" className="vv-btn vv-btn-sm" onClick={() => retryRef.current?.()}>
                <RotateCcw className="size-3.5" aria-hidden /> Réessayer
              </button>
            )}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="vv-controls">
        <button type="button" className={`vv-ctl ${muted ? 'vv-ctl-on' : ''}`} onClick={toggleMute} disabled={!isLive}
          aria-label={muted ? 'Réactiver le micro' : 'Couper le micro'} title={muted ? 'Réactiver le micro' : 'Muet'}>
          {muted ? <MicOff className="size-5" aria-hidden /> : <Mic className="size-5" aria-hidden />}
        </button>

        <button type="button" className="vv-ctl vv-ctl-stop" onClick={stopSpeaking} disabled={!isLive}
          aria-label="Arrêter la lecture" title="Arrêter la lecture (barge-in)">
          {speaking ? <VolumeX className="size-5" aria-hidden /> : <Volume2 className="size-5" aria-hidden />}
        </button>

        {isLive ? (
          <button type="button" className="vv-end" onClick={() => void stop()} aria-label="Terminer la session vocale">
            <PhoneOff className="size-5" aria-hidden />
            <span className="hidden sm:inline">Terminer</span>
          </button>
        ) : (
          <button type="button" className="vv-end vv-end-restart" onClick={restart} aria-label="Recommencer">
            <RotateCcw className="size-5" aria-hidden />
            <span className="hidden sm:inline">Recommencer</span>
          </button>
        )}

        <div className="vv-settings">
          <select className="vv-select" value={language} disabled={!isLive} aria-label="Langue"
            onChange={(e) => setLanguage(e.target.value as 'fr' | 'en')}>
            <option value="fr">FR</option>
            <option value="en">EN</option>
          </select>
          <select className="vv-select vv-select-wide" value={voiceId} disabled={!isLive} aria-label="Voix"
            onChange={(e) => setVoiceId(e.target.value)}>
            {voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
          <div className="vv-speed" title="Vitesse de lecture">
            <Gauge className="size-3.5" aria-hidden />
            <input type="range" min="0.75" max="1.25" step="0.05" value={speed} disabled={!isLive}
              onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Vitesse de lecture" />
          </div>
        </div>
      </div>
    </div>
  );
}
