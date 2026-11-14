/**
 * DictationApp — @untemps/react-vocal integration for the Nelth-IA composer.
 *
 * Headless by design: NO microphone button is rendered (the SPA's native
 * dicter button #voice-input-button is the sole control, hijacked by
 * vocal-bridge.js). This component renders only:
 *   • a status pill anchored above the dicter button while a dictation
 *     session is active (live interim transcript, pulsing dot, stop ✕);
 *   • classified error states (permission denied, no-speech, network…).
 *
 * Recognition is driven by the library's useVocal hook (default
 * WebSpeechEngine — NO custom engine):
 *   useVocal(lang, null, 1, continuous=true, interimResults=true)
 *
 * Behaviour contract:
 *   • interim results → pill preview only (NEVER inserted, never sent);
 *   • CONTINUOUS mode contract (verified in @untemps/vocal dist): the
 *     engine BUFFERS final segments and delivers ONE aggregated final
 *     transcript when the session stops — inserted ONCE into the SPA
 *     composer (#chat-input contenteditable, caret at end, execCommand
 *     insertText with DOM-append fallback), deduped per resultIndex;
 *   • the message is NEVER auto-submitted to the LLM: the user sends it
 *     through the existing chat pipeline (Enter / send button);
 *   • route change, tab hidden or unmount → stop + clean (no mic leak);
 *   • microphone permission tracked reactively (Permissions API, surfaced
 *     through the hook's permissionState) without starting a session.
 *
 * Lifecycle: the imperative open()/close()/dispose() functions are published
 * to main.tsx through the onOpen/onClose/onDispose props. grammars/engine
 * args are null/omitted (stable identity → the hook instance is created ONCE
 * per mount; sessions merely start/stop — no re-initialization churn).
 */

import * as React from 'react';
import { useVocal, classifyError, type VocalError } from '@untemps/react-vocal';

export type VocalPhase = 'idle' | 'starting' | 'listening' | 'error';

/** State published to the bridge (drives the native button's active class). */
export type VocalPublicState = {
  phase: VocalPhase;
  listening: boolean;
  permission: string | null;
};

type Props = {
  onOpen?: (fn: () => void) => void;
  onClose?: (fn: () => void) => void;
  onDispose?: (fn: () => void) => void;
  onState?: (state: VocalPublicState) => void;
};

const COMPOSER_ID = 'chat-input';
const DICTER_BUTTON_ID = 'voice-input-button';

/** FR messages per VocalError.type (classifyError contract). */
const ERROR_MESSAGES: Record<string, string> = {
  'permission-denied': 'Micro bloqué — autorisez le microphone dans les réglages du navigateur.',
  'no-speech': 'Aucune voix détectée.',
  network: 'Erreur réseau de reconnaissance.',
  'audio-capture': 'Micro inaccessible.',
  'service-not-allowed': 'Service de reconnaissance non autorisé par le navigateur.',
  aborted: 'Dictée interrompue.',
  unknown: 'Erreur de reconnaissance.',
};

function detectLang(): string {
  // SPA locale (Open WebUI stores 'locale' in localStorage) → BCP 47 tag,
  // falling back to the browser language, then French (app default).
  const norm = (v: string): string => {
    const s = (v || '').trim().toLowerCase();
    if (/^fr\b/.test(s)) return 'fr-FR';
    if (/^en\b/.test(s)) return 'en-US';
    if (/^[a-z]{2}(-[a-z]{2})?$/.test(s)) return s;
    return '';
  };
  try {
    const fromSpa = norm(localStorage.getItem('locale') || '');
    if (fromSpa) return fromSpa;
  } catch {
    /* localStorage unavailable */
  }
  const fromNav = norm(typeof navigator !== 'undefined' ? navigator.language || '' : '');
  if (fromNav) return fromNav;
  return 'fr-FR';
}

/** Insert text ONCE at the end of the SPA composer (contenteditable). */
function insertIntoComposer(text: string): boolean {
  const input = document.getElementById(COMPOSER_ID);
  if (!input || !(input instanceof HTMLElement)) return false;

  const current = (input.textContent || '').trimEnd();
  const needsSpace = current.length > 0 && !/\s$/.test(current);
  const payload = needsSpace ? ` ${text}` : text;

  input.focus();
  try {
    // Move the caret to the END of the content so the segment appends
    // deterministically (execCommand inserts at the caret).
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
  } catch {
    /* caret placement best-effort */
  }

  let ok = false;
  try {
    ok = document.execCommand('insertText', false, payload);
  } catch {
    ok = false;
  }
  if (!ok) {
    // Fallback: raw DOM append + synthetic input event (Svelte listens on
    // 'input' for its binding) — preserves the text if execCommand is absent.
    try {
      input.appendChild(document.createTextNode(payload));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      ok = true;
    } catch {
      ok = false;
    }
  }
  return ok;
}

export function DictationApp({ onOpen, onClose, onDispose, onState }: Props) {
  // Language — primitive arg (stable identity). Re-detected at each session
  // boundary so a mid-visit locale switch is honoured; a change rebuilds the
  // hook instance at a SAFE boundary (previous session already stopped).
  const [lang, setLang] = React.useState<string>(() => detectLang());

  // useVocal(lang, grammars, maxAlternatives, continuous, interimResults)
  //   • grammars = null → stable (no rebuild churn);
  //   • continuous = true → long-form dictation across segments;
  //   • interimResults = true → live provisional transcripts;
  //   • engine omitted → the library's default WebSpeechEngine.
  const [, vocalActions] = useVocal(lang, null, 1, true, true);
  const { subscribe, unsubscribe, isRecording, permissionState } = vocalActions;

  // The hook may recreate its actions object per render — capture it in a
  // ref so our imperative callbacks keep STABLE identities (published once,
  // never re-initialized per render → no duplicate subscriptions / churn).
  const actionsRef = React.useRef(vocalActions);
  React.useEffect(() => {
    actionsRef.current = vocalActions;
  }, [vocalActions]);

  const [phase, setPhase] = React.useState<VocalPhase>('idle');
  const [interim, setInterim] = React.useState('');
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [speaking, setSpeaking] = React.useState(false);
  const [pillPos, setPillPos] = React.useState<{ left: number; bottom: number } | null>(null);

  const phaseRef = React.useRef<VocalPhase>('idle');
  const startSignalRef = React.useRef<AbortController | null>(null);
  const insertedKeysRef = React.useRef<Set<string>>(new Set());
  const errorTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pillTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const setPhaseSafe = React.useCallback((next: VocalPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  // Publish the state to the bridge (the native button's active class
  // follows the phase; permission tracking surfaces here too).
  React.useEffect(() => {
    onState?.({ phase, listening: isRecording, permission: permissionState ?? null });
  }, [phase, isRecording, permissionState, onState]);

  // -------------------------------------------------------------------------
  // Classified error handling — shared by the 'error' subscription and the
  // start() promise rejection path.
  // -------------------------------------------------------------------------

  const handleError = React.useCallback(
    (err: unknown) => {
      const vocalErr: VocalError | null =
        err && typeof err === 'object' && 'type' in err ? (err as VocalError) : classifyError(err);
      if (vocalErr?.type === 'aborted') {
        // Abort = user-initiated cancel (route change / hidden tab) — silent.
        setPhaseSafe('idle');
        setInterim('');
        return;
      }
      setErrorMsg(ERROR_MESSAGES[vocalErr?.type ?? 'unknown'] || ERROR_MESSAGES.unknown);
      setPhaseSafe('error');
      setInterim('');
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => setPhaseSafe('idle'), 2600);
    },
    [setPhaseSafe]
  );

  // -------------------------------------------------------------------------
  // Event subscriptions — the recognition lifecycle (speechstart/speechend,
  // recognition start/end, result, error). subscribe/unsubscribe come from
  // the hook; handlers are stable useCallbacks; cleanup unsubscribes them all.
  // -------------------------------------------------------------------------

  const handleResult = React.useCallback(
    (event: unknown, transcript: unknown) => {
      if (phaseRef.current !== 'listening') return;
      const evt = event as
        | { resultIndex?: number; results?: Record<number, { isFinal?: boolean }> }
        | undefined;
      const idx = typeof evt?.resultIndex === 'number' ? evt.resultIndex : -1;
      const isFinal = idx >= 0 ? Boolean(evt?.results?.[idx]?.isFinal) : true;
      const text = String(transcript ?? '');

      if (!isFinal) {
        // Provisional text → pill preview ONLY. Never inserted, never sent.
        setInterim(text);
        return;
      }

      // FINAL (continuous mode: the engine's aggregated flush, delivered on
      // stop) → insert exactly once (dedupe by resultIndex+text).
      setInterim('');
      const trimmed = text.trim();
      if (!trimmed) return;
      const key = `${idx}:${trimmed}`;
      if (insertedKeysRef.current.has(key)) return;
      insertedKeysRef.current.add(key);
      insertIntoComposer(trimmed);
    },
    []
  );

  const handleRecognitionStart = React.useCallback(() => {
    setPhaseSafe('listening');
    setInterim('');
    setErrorMsg(null);
  }, [setPhaseSafe]);

  const handleRecognitionEnd = React.useCallback(() => {
    // Engine ended (explicit stop → aggregated flush already processed, or
    // browser cutoff). The stop() safety timer can be dropped now.
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setSpeaking(false);
    setInterim('');
    if (phaseRef.current === 'listening' || phaseRef.current === 'starting') {
      setPhaseSafe('idle');
    }
  }, [setPhaseSafe]);

  const handleSpeechStart = React.useCallback(() => setSpeaking(true), []);
  const handleSpeechEnd = React.useCallback(() => setSpeaking(false), []);

  React.useEffect(() => {
    subscribe('result', handleResult);
    subscribe('error', handleError);
    subscribe('start', handleRecognitionStart);
    subscribe('end', handleRecognitionEnd);
    subscribe('speechstart', handleSpeechStart);
    subscribe('speechend', handleSpeechEnd);

    return () => {
      unsubscribe('result', handleResult);
      unsubscribe('error', handleError);
      unsubscribe('start', handleRecognitionStart);
      unsubscribe('end', handleRecognitionEnd);
      unsubscribe('speechstart', handleSpeechStart);
      unsubscribe('speechend', handleSpeechEnd);
    };
  }, [
    subscribe,
    unsubscribe,
    handleResult,
    handleError,
    handleRecognitionStart,
    handleRecognitionEnd,
    handleSpeechStart,
    handleSpeechEnd,
  ]);

  // -------------------------------------------------------------------------
  // Pill positioning — anchored above the native dicter button. The SPA
  // composer grows/shrinks as text lands, so the anchor is recomputed on a
  // cheap interval while a session is active (+ resize/scroll).
  // -------------------------------------------------------------------------

  const repositionPill = React.useCallback(() => {
    const btn = document.getElementById(DICTER_BUTTON_ID);
    if (!btn) {
      setPillPos(null);
      return;
    }
    const r = btn.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - 460);
    setPillPos({
      left: Math.min(Math.max(8, r.left), maxLeft),
      bottom: Math.max(8, window.innerHeight - r.top + 10),
    });
  }, []);

  React.useEffect(() => {
    if (phase === 'idle') {
      if (pillTimerRef.current) clearInterval(pillTimerRef.current);
      pillTimerRef.current = null;
      return;
    }
    repositionPill();
    const onResizeScroll = () => repositionPill();
    window.addEventListener('resize', onResizeScroll);
    window.addEventListener('scroll', onResizeScroll, { passive: true });
    pillTimerRef.current = setInterval(repositionPill, 400);
    return () => {
      if (pillTimerRef.current) clearInterval(pillTimerRef.current);
      pillTimerRef.current = null;
      window.removeEventListener('resize', onResizeScroll);
      window.removeEventListener('scroll', onResizeScroll);
    };
  }, [phase, repositionPill]);

  // -------------------------------------------------------------------------
  // Session control (imperative API published to the bridge — stable refs).
  // -------------------------------------------------------------------------

  const open = React.useCallback(() => {
    if (phaseRef.current !== 'idle') return;
    // Fresh session: re-detect locale (may rebuild the hook instance at a
    // safe boundary — the previous session is already stopped), reset keys.
    setLang(detectLang());
    insertedKeysRef.current = new Set();
    setErrorMsg(null);
    setInterim('');
    setPhaseSafe('starting');

    const controller = new AbortController();
    startSignalRef.current = controller;
    // start() resolves once the session opens; rejects on mic/permission
    // failures → classified message via handleError.
    actionsRef.current.start({ signal: controller.signal }).catch((err: unknown) => {
      handleError(err);
    });
  }, [handleError, setPhaseSafe]);

  const close = React.useCallback(() => {
    if (phaseRef.current !== 'starting' && phaseRef.current !== 'listening') return;
    // Cancel a start still resolving (permission prompt open) — AbortSignal.
    startSignalRef.current?.abort();
    startSignalRef.current = null;
    try {
      // Graceful stop — the engine's contract (verified in @untemps/vocal
      // dist): stop() flushes the aggregated final transcript as ONE
      // 'result' event, THEN emits 'end'. Phase stays 'listening' until that
      // 'end' lands so handleResult still processes the aggregate insert.
      actionsRef.current.stop();
    } catch {
      /* engine already down */
    }
    setSpeaking(false);
    setInterim('');
    // Safety net: if 'end' never arrives (engine edge), force idle after 2s.
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      if (phaseRef.current === 'listening' || phaseRef.current === 'starting') {
        setPhaseSafe('idle');
      }
    }, 2000);
  }, [setPhaseSafe]);

  const dispose = React.useCallback(() => {
    try {
      startSignalRef.current?.abort();
      startSignalRef.current = null;
      actionsRef.current.abort();
      actionsRef.current.clean(); // removes every listener + tears the instance
    } catch {
      /* best effort */
    }
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    if (pillTimerRef.current) clearInterval(pillTimerRef.current);
    setPhaseSafe('idle');
  }, [setPhaseSafe]);

  // Publish the imperative API once (stable identities).
  React.useEffect(() => {
    onOpen?.(open);
    onClose?.(close);
    onDispose?.(dispose);
  }, [open, close, dispose, onOpen, onClose, onDispose]);

  // Belt-and-braces: tab hidden → stop (mic never stays hot in background).
  React.useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') close();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [close]);

  // Final safety net — dispose on unmount (main.tsx's unmount() calls it,
  // this guarantees teardown even for React-native unmount paths).
  React.useEffect(() => dispose, [dispose]);

  // -------------------------------------------------------------------------
  // Render — the status pill ONLY (no microphone button, ever).
  // -------------------------------------------------------------------------

  if (phase === 'idle') return null;

  const label =
    phase === 'starting'
      ? 'Connexion du micro…'
      : phase === 'error'
        ? (errorMsg ?? ERROR_MESSAGES.unknown)
        : interim
          ? interim
          : speaking
            ? 'À l\u2019écoute…'
            : 'Dictée en cours — cliquez sur le micro pour insérer le texte.';

  return (
    <div
      className="nvl-pill"
      style={
        pillPos
          ? { left: `${pillPos.left}px`, bottom: `${pillPos.bottom}px` }
          : { bottom: '120px', left: '50%', transform: 'translateX(-50%)' }
      }
      role="status"
      aria-live="polite"
      aria-label="Dictée vocale"
    >
      <span
        className={`nvl-dot${phase === 'listening' ? (speaking ? ' nvl-live' : '') : ''}${phase === 'error' ? ' nvl-error' : ''}`}
        aria-hidden
      />
      <span className={`nvl-text${phase === 'error' ? ' nvl-text-error' : ''}`} title={label}>
        {label}
      </span>
      {phase !== 'error' && (
        <button type="button" className="nvl-stop" aria-label="Arrêter la dictée" onClick={close}>
          <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12" aria-hidden>
            <path d="M5 5h10v10H5z" />
          </svg>
        </button>
      )}
    </div>
  );
}
