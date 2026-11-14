/**
 * VoiceApp — real-time voice conversation overlay, design d'après la
 * maquette utilisateur (capture) : fond uni clair, orbe « cloud blue »
 * centré (~112px, dégradé aquarelle animé), AUCUN texte visible, deux
 * boutons circulaires gris clair en bas-centre (micro + ×), petite icône
 * cast en haut à droite qui ouvre les options (langue, voix, vitesse,
 * transcription, stop lecture).
 *
 * SPEECH RECOGNITION — @untemps/react-vocal (useVocal hook, default
 * WebSpeechEngine, NO custom engine, NO server STT):
 *   • single-shot recognition per listening window (interim results ON);
 *   • interim transcripts → provisional display ONLY (never submitted);
 *   • final transcript → POST /api/voice/turn (EXISTING pipeline: Kilo
 *     LLM streaming + Edge TTS sentence chunks over SSE);
 *   • recognition pauses while the assistant speaks (no speaker echo in
 *     the recognizer); the local energy VAD keeps the BARGE-IN alive and
 *     the mic capture NEVER stops (orb level + animation);
 *   • isSupported() gate: browsers without the Web Speech API get a clear
 *     error — never a silently nonfunctional microphone button;
 *   • errors classified through the library's classifyError().
 *
 * States (machine inchangée) : idle → connecting → listening ⇄ thinking ⇄
 * speaking — le niveau du micro anime l'orbe en continu.
 */

import * as React from 'react';
import { Mic, MicOff, X, Cast, Gauge, VolumeX, Subtitles, AlertTriangle, RotateCcw, Loader2 } from 'lucide-react';
import { useVocal, classifyError, isSupported, type VocalError } from '@untemps/react-vocal';
import type { VoiceEvent } from '@/lib/voice/protocol';
import { PlaybackQueue, startCapture, type CaptureHandle } from './audio';
import {
  createSession, openEventStream, postTurn, postInterrupt, postEnd, fetchCatalogue,
  type SessionInfo, type VoiceCatalogue,
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

/** FR messages per VocalError.type (classifyError contract). */
const ERROR_MESSAGES: Record<string, string> = {
  'permission-denied': 'Micro bloqué — autorisez le microphone dans les réglages du navigateur.',
  'no-speech': 'Aucune voix détectée.',
  network: 'Erreur réseau de reconnaissance.',
  'audio-capture': 'Micro inaccessible.',
  'service-not-allowed': 'Service de reconnaissance non autorisé par le navigateur.',
  aborted: 'Reconnaissance interrompue.',
  unknown: 'Erreur de reconnaissance.',
};

/** Errors that stop the auto-restart loop (fatal microphone/recognition). */
const FATAL_REC_ERRORS = new Set(['permission-denied', 'audio-capture', 'service-not-allowed']);

export function VoiceApp({ chatId, onClose }: Props) {
  const supported = React.useMemo(() => isSupported(), []);

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
  const [showOptions, setShowOptions] = React.useState(false);
  const [showTranscript, setShowTranscript] = React.useState(false);
  const [speaking, setSpeaking] = React.useState(false);

  const sessionRef = React.useRef<SessionInfo | null>(null);
  const captureRef = React.useRef<CaptureHandle | null>(null);
  const eventsRef = React.useRef<{ close: () => void } | null>(null);
  const playbackRef = React.useRef<PlaybackQueue | null>(null);
  const mutedRef = React.useRef(false);
  const liveRef = React.useRef(false);
  const speakingRef = React.useRef(false);
  const answerRef = React.useRef('');
  const localVadRef = React.useRef({ above: 0 });
  const retryRef = React.useRef<(() => void) | null>(null);
  const optionsRef = React.useRef<HTMLDivElement | null>(null);

  // --- recognition state (useVocal) --------------------------------------
  const orbStateRef = React.useRef<OrbState>('idle');
  const turnBusyRef = React.useRef(false);
  const startSignalRef = React.useRef<AbortController | null>(null);
  const restartTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const recEpochRef = React.useRef(0);
  const sentKeysRef = React.useRef<Set<string>>(new Set());

  const setOrbStateSafe = React.useCallback((next: OrbState) => {
    orbStateRef.current = next;
    setOrbState(next);
  }, []);

  // BCP 47 tag for the recognizer — primitive arg, stable per language
  // (a change rebuilds the hook instance at a SAFE boundary: the previous
  // recognition session is already stopped when a turn is in flight).
  const recLang = React.useMemo(() => (language === 'en' ? 'en-US' : 'fr-FR'), [language]);

  // useVocal(lang, grammars, maxAlternatives, continuous, interimResults)
  //   • grammars = null → stable (no rebuild churn);
  //   • continuous = false → single-shot per listening window: ONE final
  //     per utterance, the engine ends by itself (no speaker-echo turns);
  //   • interimResults = true → live provisional transcripts;
  //   • engine omitted → the library's default WebSpeechEngine.
  const [, vocalActions] = useVocal(recLang, null, 1, false, true);
  const { subscribe, unsubscribe } = vocalActions;

  // The hook may recreate its actions object per render — capture it in a
  // ref so our imperative callbacks keep STABLE identities (no repeated
  // recognition initialization per render, no duplicate subscriptions).
  const actionsRef = React.useRef(vocalActions);
  React.useEffect(() => {
    actionsRef.current = vocalActions;
  }, [vocalActions]);

  // Breaks the start↔error callback cycle with a stable indirection.
  const recErrorRef = React.useRef<(err: unknown) => void>(() => undefined);

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
        const sid = sessionRef.current?.sessionId;
        if (sid) void postInterrupt(sid);
      }
    } else {
      localVadRef.current.above = Math.max(0, localVadRef.current.above - 1);
    }
  }, []);

  // -----------------------------------------------------------------------
  // Recognition control — start/stop with guards (no mic leak, no double
  // start; AbortSignal cancels a start still resolving, e.g. permission
  // prompt open when the user leaves). Refs ONLY → stable identities.
  // -----------------------------------------------------------------------
  const stopRecognition = React.useCallback(() => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    startSignalRef.current?.abort();
    startSignalRef.current = null;
    try {
      actionsRef.current.stop();
    } catch {
      /* engine already down */
    }
  }, []);

  const armListening = React.useCallback(() => {
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    restartTimerRef.current = setTimeout(() => {
      restartTimerRef.current = null;
      if (!liveRef.current || mutedRef.current || turnBusyRef.current || speakingRef.current) return;
      if (playbackRef.current?.playing) return; // assistant audio still flowing
      const st = orbStateRef.current;
      if (st === 'thinking' || st === 'speaking' || st === 'connecting' || st === 'error') return;
      if (startSignalRef.current) return; // a start is already resolving
      const controller = new AbortController();
      startSignalRef.current = controller;
      actionsRef.current.start({ signal: controller.signal }).then(() => {
        startSignalRef.current = null;
      }).catch((err: unknown) => {
        startSignalRef.current = null;
        recErrorRef.current(err);
      });
    }, 350);
  }, []);

  // -----------------------------------------------------------------------
  // Classified recognition errors — the library's classifyError contract.
  // -----------------------------------------------------------------------
  const handleRecError = React.useCallback(
    (err: unknown) => {
      const vocalErr: VocalError | null =
        err && typeof err === 'object' && 'type' in err ? (err as VocalError) : classifyError(err);
      const t = vocalErr?.type ?? 'unknown';
      if (t === 'aborted') return; // user-initiated cancel — silent
      if (t === 'no-speech') {
        // Benign single-shot silence timeout → keep listening.
        setPartial('');
        armListening();
        return;
      }
      setError(ERROR_MESSAGES[t] || ERROR_MESSAGES.unknown);
      setPartial('');
      if (FATAL_REC_ERRORS.has(t)) setOrbStateSafe('error');
    },
    [armListening, setOrbStateSafe]
  );

  React.useEffect(() => {
    recErrorRef.current = handleRecError;
  }, [handleRecError]);

  // -----------------------------------------------------------------------
  // Assistant turn — the FINAL transcript enters the EXISTING pipeline.
  // Interim transcripts never reach this path (provisional display only).
  // -----------------------------------------------------------------------
  const submitTurn = React.useCallback((text: string) => {
    const sid = sessionRef.current?.sessionId;
    if (!sid || turnBusyRef.current || !liveRef.current) return;
    turnBusyRef.current = true;
    setPartial('');
    setAnswer(text);
    answerRef.current = '';
    setOrbStateSafe('thinking');
    postTurn(sid, text).catch((e: unknown) => {
      turnBusyRef.current = false;
      const msg = e instanceof Error ? e.message : 'Erreur d\'envoi du tour.';
      setError(msg);
      setOrbStateSafe('listening');
      armListening();
    });
  }, [armListening, setOrbStateSafe]);

  // -----------------------------------------------------------------------
  // Recognition event subscriptions — result (interim/final), start, end,
  // speechstart, speechend, error. Stable handlers; when the hook rebuilds
  // its actions object (language change) the effect resubscribes to the NEW
  // engine instance and drops the old listeners — never duplicated.
  // -----------------------------------------------------------------------
  const handleResult = React.useCallback(
    (event: unknown, transcript: unknown) => {
      if (orbStateRef.current !== 'listening') return;
      const evt = event as
        | { resultIndex?: number; results?: Record<number, { isFinal?: boolean }> }
        | undefined;
      const idx = typeof evt?.resultIndex === 'number' ? evt.resultIndex : -1;
      const isFinal = idx >= 0 ? Boolean(evt?.results?.[idx]?.isFinal) : true;
      const text = String(transcript ?? '');

      if (!isFinal) {
        // Provisional text → transcript display ONLY. Never submitted.
        setPartial(text);
        return;
      }

      // FINAL → submit EXACTLY once (dedupe by recognition epoch + index
      // + text — the engine never delivers the same final twice).
      const trimmed = text.trim();
      if (!trimmed) return;
      const key = `${recEpochRef.current}:${idx}:${trimmed}`;
      if (sentKeysRef.current.has(key)) return;
      sentKeysRef.current.add(key);
      submitTurn(trimmed);
    },
    [submitTurn]
  );

  const handleRecognitionStart = React.useCallback(() => {
    recEpochRef.current += 1;
    setPartial('');
    setError(null);
    setOrbStateSafe('listening');
  }, [setOrbStateSafe]);

  const handleRecognitionEnd = React.useCallback(() => {
    // Single-shot engine ended: either a final was delivered (turn in
    // flight → the turn lifecycle restarts recognition) or silence
    // timeout → re-arm listening.
    setPartial('');
    if (turnBusyRef.current || !liveRef.current || mutedRef.current) return;
    armListening();
  }, [armListening]);

  const handleSpeechStart = React.useCallback(() => {
    // The level meter animates the orb; nothing else to do.
  }, []);
  const handleSpeechEnd = React.useCallback(() => {
    /* kept for lifecycle parity */
  }, []);

  React.useEffect(() => {
    subscribe('result', handleResult);
    subscribe('error', handleRecError);
    subscribe('start', handleRecognitionStart);
    subscribe('end', handleRecognitionEnd);
    subscribe('speechstart', handleSpeechStart);
    subscribe('speechend', handleSpeechEnd);

    return () => {
      unsubscribe('result', handleResult);
      unsubscribe('error', handleRecError);
      unsubscribe('start', handleRecognitionStart);
      unsubscribe('end', handleRecognitionEnd);
      unsubscribe('speechstart', handleSpeechStart);
      unsubscribe('speechend', handleSpeechEnd);
    };
  }, [
    subscribe,
    unsubscribe,
    handleResult,
    handleRecError,
    handleRecognitionStart,
    handleRecognitionEnd,
    handleSpeechStart,
    handleSpeechEnd,
  ]);

  // -----------------------------------------------------------------------
  // Event channel (SSE) — assistant turn events from the EXISTING pipeline.
  // -----------------------------------------------------------------------
  const onEvent = React.useCallback((ev: VoiceEvent) => {
    const p = (ev as any).payload;
    switch (ev.type) {
      case 'llm.started':
        setStreamingAnswer('');
        setOrbStateSafe('thinking');
        break;
      case 'llm.token':
        answerRef.current += String(p?.text ?? '');
        setStreamingAnswer(answerRef.current);
        break;
      case 'tts.started':
        setOrbStateSafe('speaking');
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
        setError(String(p?.reason ?? 'Synthèse vocale indisponible — aucune bascule automatique.'));
        break;
      case 'vad.interruption_detected':
      case 'assistant.interrupted':
        playbackRef.current?.stop();
        speakingRef.current = false;
        setSpeaking(false);
        setInterruptedCount((n) => n + 1);
        setOrbStateSafe('listening');
        turnBusyRef.current = false;
        armListening();
        break;
      case 'assistant.finished':
        setStreamingAnswer('');
        setAnswer(String(p?.text ?? ''));
        speakingRef.current = false;
        setSpeaking(false);
        setOrbStateSafe('listening');
        turnBusyRef.current = false;
        if (p?.chatId && sessionRef.current) sessionRef.current.chatId = String(p.chatId);
        armListening();
        break;
      case 'session.error': {
        const msg = String(p?.message ?? 'Erreur');
        setError(msg);
        const stage = String(p?.stage ?? '');
        if (stage === 'llm') {
          // Turn failed before audio: re-arm the microphone.
          turnBusyRef.current = false;
          setOrbStateSafe('listening');
          armListening();
        }
        if (!p?.recoverable) setOrbStateSafe('error');
        break;
      }
      case 'session.ended':
        setPhase('ended');
        liveRef.current = false;
        stopRecognition();
        break;
    }
  }, [armListening, setOrbStateSafe, stopRecognition]);

  // -----------------------------------------------------------------------
  // Start / stop — mic capture (level + barge-in) → session → SSE channel
  // → recognition. Single HTTP/SSE transport: STT is browser-side.
  // -----------------------------------------------------------------------
  const start = React.useCallback(async () => {
    setError(null);
    setMicError(null);
    setOrbStateSafe('connecting');

    if (!supported) {
      // Web Speech API unavailable → clear report, NO session, NO dead mic.
      setOrbStateSafe('error');
      setError('La reconnaissance vocale n\'est pas supportée par ce navigateur (Web Speech API requise — Chrome ou Edge recommandés).');
      return;
    }

    try {
      const cat = catalogue ?? (await fetchCatalogue());
      setCatalogue(cat);
      const lang = (cat.defaultLanguage === 'en' ? 'en' : 'fr') as 'fr' | 'en';
      setLanguage(lang);
      setVoiceId((v) => v || cat.voices.find((x) => x.language === lang)?.id || cat.voices[0]?.id || '');

      setPhase('requesting-mic');
      const capture = await startCapture({ onLevel: handleLevel });
      captureRef.current = capture;

      const session = await createSession({ language: lang, voice: voiceId || undefined, speed, chatId });
      sessionRef.current = session;

      playbackRef.current = new PlaybackQueue({
        onSpeakingChange: (sp) => {
          if (!sp) {
            setTimeout(() => {
              if (orbStateRef.current === 'speaking') setOrbStateSafe('listening');
            }, 80);
            // Playback drained and the turn already closed → mic resumes.
            if (!turnBusyRef.current) armListening();
          }
        },
      });

      eventsRef.current = openEventStream(session.sessionId, onEvent);

      liveRef.current = true;
      setPhase('live');
      setOrbStateSafe('listening');
      turnBusyRef.current = false;
      sentKeysRef.current = new Set();
      armListening();
    } catch (e: any) {
      setOrbStateSafe('error');
      const msg = e?.message ?? String(e);
      if (/permission|denied|notallowed/i.test(msg)) setMicError('Micro refusé — autorisez le microphone dans votre navigateur.');
      else if (/not\s*found|no\s*device/i.test(msg)) setMicError('Aucun micro détecté sur cet appareil.');
      else setError(msg);
      stopRecognition();
      captureRef.current?.close();
      captureRef.current = null;
    }
  }, [catalogue, voiceId, speed, chatId, supported, handleLevel, onEvent, armListening, setOrbStateSafe, stopRecognition]);

  React.useEffect(() => {
    retryRef.current = start;
  }, [start]);

  const stop = React.useCallback(async () => {
    liveRef.current = false;
    turnBusyRef.current = false;
    stopRecognition();
    eventsRef.current?.close();
    eventsRef.current = null;
    playbackRef.current?.stop();
    speakingRef.current = false;
    const sid = sessionRef.current?.sessionId;
    if (sid) await postEnd(sid).catch(() => undefined);
    await captureRef.current?.close();
    captureRef.current = null;
    setPhase('ended');
    setOrbStateSafe('idle');
    setLevel(0);
    setPartial('');
  }, [setOrbStateSafe, stopRecognition]);

  React.useEffect(() => {
    void start();
    return () => {
      liveRef.current = false;
      stopRecognition();
      try {
        // Full engine teardown — no microphone leak after leaving the
        // voice screen (same dispose contract as the composer dictation).
        actionsRef.current.abort();
        actionsRef.current.clean();
      } catch {
        /* best effort */
      }
      eventsRef.current?.close();
      playbackRef.current?.stop();
      captureRef.current?.close();
    };
  }, []);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    mutedRef.current = next;
    if (next) {
      stopRecognition();
      setPartial('');
    } else {
      armListening();
    }
  };

  const stopSpeaking = () => {
    const sid = sessionRef.current?.sessionId;
    if (sid) void postInterrupt(sid);
    playbackRef.current?.stop();
    speakingRef.current = false;
    setSpeaking(false);
    setOrbStateSafe('listening');
  };

  const restart = () => {
    void (async () => {
      await stop();
      setPartial(''); setAnswer(''); setStreamingAnswer(''); setError(null); setInterruptedCount(0); setShowOptions(false);
      void start();
    })();
  };

  const leave = () => { void stop(); onClose?.(); };

  // Belt-and-braces: tab hidden → stop recognition (mic never hot in bg).
  React.useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stopRecognition();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [stopRecognition]);

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
            <span>Web Speech (react-vocal)</span>
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
            the options popover. Interim text stays PROVISIONAL here. */}
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
        <button type="button" className={`vv-ctl ${muted ? 'vv-ctl-muted' : ''}`} onClick={toggleMute} disabled={!isLive || !supported}
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
