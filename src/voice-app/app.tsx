/**
 * VoiceApp — real-time voice conversation overlay, design d'après la
 * maquette utilisateur (capture) : fond uni clair, orbe « cloud blue »
 * centré (~112px, dégradé aquarelle animé), AUCUN texte visible, deux
 * boutons circulaires gris clair en bas-centre (micro + ×), petite icône
 * cast en haut à droite qui ouvre les options (langue, voix, vitesse,
 * transcription, stop lecture).
 *
 * Toute la logique testée est conservée : capture micro plein duplex,
 * double transport (WebSocket bidirectionnel → repli HTTP+SSE), VAD local
 * barge-in, interruption, file de lecture TTS, mute, relance, erreurs.
 * States (machine inchangée) : idle → connecting → listening ⇄ thinking ⇄
 * speaking — le micro ne s'arrête JAMAIS (full duplex).
 */

import * as React from 'react';
import { Mic, MicOff, X, Cast, Gauge, VolumeX, Subtitles, AlertTriangle, RotateCcw, Loader2 } from 'lucide-react';
import type { VoiceEvent } from '@/lib/voice/protocol';
import { PlaybackQueue, startCapture, type CaptureHandle } from './audio';
import {
  createSession, openEventStream, openVoiceSocket, postAudio, postInterrupt, postEnd, fetchCatalogue,
  type SessionInfo, type VoiceCatalogue, type VoiceSocket,
} from './api';

type OrbState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

type Props = {
  chatId: string | null;
  onClose?: () => void;
};

const SR_STATE_LABELS: Record<OrbState, string> = {
  idle: 'Prêt',
  connecting: 'Connexion en cours',
  listening: 'Je vous écoute',
  thinking: 'Réflexion',
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
  const [transport, setTransport] = React.useState<'ws' | 'sse' | null>(null);
  const [showOptions, setShowOptions] = React.useState(false);
  const [showTranscript, setShowTranscript] = React.useState(false);
  const [speaking, setSpeaking] = React.useState(false);

  const sessionRef = React.useRef<SessionInfo | null>(null);
  const captureRef = React.useRef<CaptureHandle | null>(null);
  const eventsRef = React.useRef<{ close: () => void } | null>(null);
  const socketRef = React.useRef<VoiceSocket | null>(null);
  const playbackRef = React.useRef<PlaybackQueue | null>(null);
  const mutedRef = React.useRef(false);
  const liveRef = React.useRef(false);
  const speakingRef = React.useRef(false);
  const answerRef = React.useRef('');
  const localVadRef = React.useRef({ above: 0 });
  const retryRef = React.useRef<(() => void) | null>(null);
  const optionsRef = React.useRef<HTMLDivElement | null>(null);

  // -----------------------------------------------------------------------
  // Local barge-in VAD (signal processing ONLY — no inference): sustained
  // mic energy while the assistant speaks → interrupt. (unchanged, tested)
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
        localVadRef.current.above = 0;
        const sock = socketRef.current;
        const sid = sessionRef.current?.sessionId;
        if (sock) sock.sendInterrupt();
        else if (sid) void postInterrupt(sid);
      }
    } else {
      localVadRef.current.above = Math.max(0, localVadRef.current.above - 1);
    }
  }, []);

  const handleFrame = React.useCallback((pcm: Int16Array) => {
    if (mutedRef.current) return;
    const sock = socketRef.current;
    if (sock) { sock.sendAudio(pcm); return; }
    const sid = sessionRef.current?.sessionId;
    if (sid) void postAudio(sid, pcm);
  }, []);

  // -----------------------------------------------------------------------
  // Event channel — one handler for BOTH transports (WS + SSE share the
  // VoiceEvent wire format).
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
  // Start / stop — WebSocket first, HTTP+SSE fallback (tested pipeline).
  // -----------------------------------------------------------------------
  const downgradeToSse = React.useCallback((sid: string) => {
    socketRef.current = null;
    if (eventsRef.current) return; // already downgraded
    eventsRef.current = openEventStream(sid, onEvent);
    setTransport('sse');
    setError('Connexion directe interrompue — canal de secours activé.');
  }, [onEvent]);

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

      // Transport 1 — bidirectional WebSocket (Vercel Public Beta).
      const sock = await openVoiceSocket(session.sessionId, onEvent, () => downgradeToSse(session.sessionId));
      socketRef.current = sock;
      if (sock) setTransport('ws');
      else {
        // Transport 2 — HTTP + SSE (the tested pipeline).
        eventsRef.current = openEventStream(session.sessionId, onEvent);
        setTransport('sse');
      }

      liveRef.current = true;
      setPhase('live');
      setOrbState('listening');
    } catch (e: any) {
      setOrbState('error');
      const msg = e?.message ?? String(e);
      if (/permission|denied|notallowed/i.test(msg)) setMicError('Micro refusé — autorisez le microphone dans votre navigateur.');
      else if (/not\s*found|no\s*device/i.test(msg)) setMicError('Aucun micro détecté sur cet appareil.');
      else setError(msg);
      captureRef.current?.close();
      captureRef.current = null;
    }
  }, [catalogue, voiceId, speed, chatId, handleFrame, handleLevel, onEvent, downgradeToSse]);

  React.useEffect(() => {
    retryRef.current = start;
  }, [start]);

  const stop = React.useCallback(async () => {
    liveRef.current = false;
    eventsRef.current?.close();
    eventsRef.current = null;
    const sock = socketRef.current;
    socketRef.current = null;
    playbackRef.current?.stop();
    speakingRef.current = false;
    const sid = sessionRef.current?.sessionId;
    if (sock) { sock.sendEnd(); sock.close(); }
    if (sid && !sock) await postEnd(sid).catch(() => undefined);
    await captureRef.current?.close();
    captureRef.current = null;
    setPhase('ended');
    setOrbState('idle');
    setLevel(0);
    setTransport(null);
  }, []);

  React.useEffect(() => {
    void start();
    return () => {
      liveRef.current = false;
      eventsRef.current?.close();
      socketRef.current?.close();
      socketRef.current = null;
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
    const sock = socketRef.current;
    const sid = sessionRef.current?.sessionId;
    if (sock) sock.sendInterrupt();
    else if (sid) void postInterrupt(sid);
    playbackRef.current?.stop();
    speakingRef.current = false;
    setOrbState('listening');
  };

  const restart = () => {
    void (async () => {
      await stop();
      setPartial(''); setAnswer(''); setStreamingAnswer(''); setError(null); setInterruptedCount(0); setShowOptions(false);
      void start();
    })();
  };

  const leave = () => { void stop(); onClose?.(); };

  // Close the options popover on outside tap.
  React.useEffect(() => {
    if (!showOptions) return;
    const onDoc = (e: MouseEvent) => {
      if (optionsRef.current && !optionsRef.current.contains(e.target as Node)) setShowOptions(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [showOptions]);

  // -----------------------------------------------------------------------
  // Render — design capture : fond uni, orbe centré, zéro texte visible,
  // 2 boutons bas-centre (micro + ×), icône cast haut-droite (options).
  // -----------------------------------------------------------------------
  const isLive = phase === 'live';
  const voices = catalogue?.voices.filter((v) => v.language === language) ?? [];

  const orbScale = 1 + Math.min(0.09, level * (muted ? 0 : 0.09)) + (speaking ? 0.03 : 0);

  return (
    <div className="vv-root" data-phase={phase} data-muted={muted}>
      {/* sr-only live status — the design shows no text; a11y keeps one. */}
      <p className="vv-sr" role="status" aria-live="polite">
        {phase === 'requesting-mic' ? 'Demande de microphone' : SR_STATE_LABELS[orbState]}
      </p>

      {/* Top-right — cast glyph (design) → opens the options popover. */}
      <button type="button" className="vv-cast" aria-label="Options de la conversation vocale" title="Options"
        onClick={() => setShowOptions((v) => !v)}>
        <Cast className="vv-cast-icon" aria-hidden />
      </button>

      {showOptions && (
        <div className="vv-popover" ref={optionsRef} role="dialog" aria-label="Options vocales">
          <div className="vv-pop-row">
            <span className="vv-pop-label">Langue</span>
            <div className="vv-pop-seg">
              <button type="button" className={`vv-seg ${language === 'fr' ? 'vv-seg-on' : ''}`} onClick={() => setLanguage('fr')}>FR</button>
              <button type="button" className={`vv-seg ${language === 'en' ? 'vv-seg-on' : ''}`} onClick={() => setLanguage('en')}>EN</button>
            </div>
          </div>
          <div className="vv-pop-row">
            <span className="vv-pop-label">Voix</span>
            <select className="vv-pop-select" value={voiceId} disabled={!isLive} aria-label="Voix"
              onChange={(e) => setVoiceId(e.target.value)}>
              {voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </div>
          <div className="vv-pop-row">
            <span className="vv-pop-label">Vitesse</span>
            <div className="vv-pop-speed" title="Vitesse de lecture">
              <Gauge className="vv-pop-speed-icon" aria-hidden />
              <input type="range" min="0.75" max="1.25" step="0.05" value={speed} disabled={!isLive}
                onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Vitesse de lecture" />
            </div>
          </div>
          <div className="vv-pop-row vv-pop-row-actions">
            <button type="button" className="vv-pop-act" onClick={() => setShowTranscript((v) => !v)}
              aria-expanded={showTranscript}>
              <Subtitles className="vv-pop-act-icon" aria-hidden />
              <span>{showTranscript ? 'Masquer' : 'Transcription'}</span>
            </button>
            <button type="button" className="vv-pop-act" onClick={stopSpeaking} disabled={!speaking}>
              <VolumeX className="vv-pop-act-icon" aria-hidden />
              <span>Stop lecture</span>
            </button>
            <button type="button" className="vv-pop-act" onClick={restart}>
              <RotateCcw className="vv-pop-act-icon" aria-hidden />
              <span>Recommencer</span>
            </button>
          </div>
          <div className="vv-pop-meta">
            {transport && <span>{transport === 'ws' ? 'WebSocket' : 'HTTP+SSE'}</span>}
            {interruptedCount > 0 && <span>{interruptedCount} interruption{interruptedCount > 1 ? 's' : ''}</span>}
          </div>
        </div>
      )}

      {/* Center — the cloud-blue orb (design replica), tap = barge-in. */}
      <div className="vv-center">
        <button type="button" className="vv-orb" data-state={orbState} style={{ ['--vv-scale' as any]: orbScale }}
          onClick={speaking ? stopSpeaking : undefined}
          aria-label={speaking ? 'Arrêter la lecture' : SR_STATE_LABELS[orbState]}
          title={speaking ? 'Arrêter la lecture' : undefined}>
          <span className="vv-orb-blob vv-orb-blob-a" aria-hidden />
          <span className="vv-orb-blob vv-orb-blob-b" aria-hidden />
          <span className="vv-orb-blob vv-orb-blob-c" aria-hidden />
          <span className="vv-orb-shine" aria-hidden />
          <span className="vv-orb-core" aria-hidden />
        </button>

        {(micError || error) && (
          <div className="vv-error" role="alert">
            <AlertTriangle className="vv-error-icon" aria-hidden />
            <span>{micError ?? error}</span>
            {(micError || !isLive) && (
              <button type="button" className="vv-error-retry" onClick={() => retryRef.current?.()}>
                <RotateCcw className="vv-error-retry-icon" aria-hidden /> Réessayer
              </button>
            )}
          </div>
        )}
        {phase === 'requesting-mic' && !micError && !error && (
          <div className="vv-error vv-error-info" role="status">
            <Loader2 className="vv-error-icon vv-error-spin" aria-hidden />
            <span>Micro…</span>
          </div>
        )}

        {/* Transcription — hidden by default (design: no text), toggled from
            the options popover. */}
        {showTranscript && (
          <div className="vv-transcript" role="log" aria-live="polite">
            <div className="vv-partial" data-empty={!partial}>{partial || ' '}</div>
            {(answer || streamingAnswer) && (
              <div className="vv-answer">
                <span className="vv-answer-user">{answer}</span>
                {streamingAnswer && <span className="vv-answer-stream">{streamingAnswer}<span className="vv-caret" aria-hidden /></span>}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom-center — two light-gray circles: mic (mute) + × (leave). */}
      <div className="vv-controls">
        <button type="button" className={`vv-ctl ${muted ? 'vv-ctl-muted' : ''}`} onClick={toggleMute} disabled={!isLive}
          aria-label={muted ? 'Réactiver le micro' : 'Couper le micro'} title={muted ? 'Réactiver le micro' : 'Muet'}>
          {muted ? <MicOff className="vv-ctl-icon" aria-hidden /> : <Mic className="vv-ctl-icon" aria-hidden />}
        </button>
        <button type="button" className="vv-ctl vv-ctl-exit" onClick={leave}
          aria-label="Quitter la conversation vocale" title="Quitter">
          <X className="vv-ctl-icon" aria-hidden />
        </button>
      </div>
    </div>
  );
}
