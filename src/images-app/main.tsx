/**
 * Nelth-IA Images — point d'entrée du bundle autonome.
 *
 * Le bridge SPA (public/static/images-bridge.js) charge ce fichier
 * (public/static/images/main.js) et monte l'application React dans
 * l'overlay central — la barre latérale du SPA reste montée en permanence.
 */

import { createRoot } from 'react-dom/client';
import { ImagesApp } from './app';

type MountApi = {
  mount(el: HTMLElement): void;
  unmount(): void;
};

declare global {
  interface Window {
    NelthImages?: MountApi;
  }
}

let root: ReturnType<typeof createRoot> | null = null;
let mountedEl: HTMLElement | null = null;

window.NelthImages = {
  mount(el: HTMLElement) {
    // Le conteneur central peut être remplacé par le routeur SPA —
    // un nouveau montage recrée proprement la racine React.
    if (root && mountedEl !== el) {
      try {
        root.unmount();
      } catch {
        /* already unmounted */
      }
      root = null;
    }
    if (!root) {
      root = createRoot(el);
      mountedEl = el;
    }
    root.render(<ImagesApp />);
  },
  unmount() {
    try {
      root?.unmount();
    } catch {
      /* already unmounted */
    }
    root = null;
    mountedEl = null;
  },
};
