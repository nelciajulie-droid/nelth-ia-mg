/**
 * Nelth-IA Vocal — standalone bundle entry (mounted by vocal-bridge.js).
 *
 * Wraps @untemps/react-vocal's useVocal behind a tiny imperative window API
 * so the Svelte SPA bridge can drive the dictation without React knowledge:
 *
 *   window.NelthVocal.isSupported()  — library isSupported (SSR-safe, re-exported)
 *   window.NelthVocal.mount(el, { onState }) — mount the React app (headless pill)
 *   window.NelthVocal.unmount()      — unmount + clean (kills the mic)
 *   window.NelthVocal.open()          — start a dictation session
 *   window.NelthVocal.close()         — stop the dictation session
 *
 * The bundle NEVER renders a microphone button: the SPA's native dicter
 * button (#voice-input-button) stays the only control (hijacked by the
 * bridge, capture-phase).
 */

import { createRoot } from 'react-dom/client';
import { isSupported } from '@untemps/react-vocal';
import { DictationApp, type VocalPublicState } from './app';

type MountApi = {
  mount(el: HTMLElement, opts?: { onState?: (state: VocalPublicState) => void }): void;
  unmount(): void;
  open(): void;
  close(): void;
  isSupported(): boolean;
};

declare global {
  interface Window {
    NelthVocal?: MountApi;
  }
}

// The React app publishes its imperative controller here (set from inside the
// component tree, read from this module-level API wrapper).
let openImpl: (() => void) | null = null;
let closeImpl: (() => void) | null = null;
let disposeImpl: (() => void) | null = null;

let root: ReturnType<typeof createRoot> | null = null;
let mountedEl: HTMLElement | null = null;

window.NelthVocal = {
  isSupported: () => isSupported(),

  mount(el, opts) {
    if (root && mountedEl !== el) {
      try {
        root.unmount();
      } catch {
        /* already unmounted */
      }
      root = null;
      disposeImpl = null;
    }
    if (!root) {
      root = createRoot(el);
      mountedEl = el;
    }
    root.render(
      <DictationApp
        onOpen={(fn) => (openImpl = fn)}
        onClose={(fn) => (closeImpl = fn)}
        onDispose={(fn) => (disposeImpl = fn)}
        onState={opts?.onState}
      />
    );
  },

  unmount() {
    try {
      disposeImpl?.();
    } catch {
      /* best effort */
    }
    try {
      root?.unmount();
    } catch {
      /* already unmounted */
    }
    root = null;
    mountedEl = null;
    openImpl = null;
    closeImpl = null;
    disposeImpl = null;
  },

  open() {
    openImpl?.();
  },

  close() {
    closeImpl?.();
  },
};
