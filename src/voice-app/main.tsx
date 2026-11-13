/**
 * Nelth-IA Voice — standalone bundle entry (mounted by voice-bridge.js).
 */

import { createRoot } from 'react-dom/client';
import { VoiceApp } from './app';

type MountApi = {
  mount(el: HTMLElement, opts?: { chatId?: string | null; onClose?: () => void }): void;
  unmount(): void;
};

declare global {
  interface Window {
    NelthVoice?: MountApi;
  }
}

let root: ReturnType<typeof createRoot> | null = null;
let mountedEl: HTMLElement | null = null;

window.NelthVoice = {
  mount(el, opts) {
    if (root && mountedEl !== el) {
      try { root.unmount(); } catch { /* already unmounted */ }
      root = null;
    }
    if (!root) {
      root = createRoot(el);
      mountedEl = el;
    }
    root.render(<VoiceApp chatId={opts?.chatId ?? null} onClose={opts?.onClose} />);
  },
  unmount() {
    try { root?.unmount(); } catch { /* already unmounted */ }
    root = null;
    mountedEl = null;
  },
};
