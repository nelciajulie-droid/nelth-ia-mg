/**
 * Nelth-AI Documents — point d'entrée du bundle autonome.
 *
 * Le pont SPA (documents-bridge) charge ce fichier (public/static/documents/
 * main.js) et pilote l'overlay par le contrat window.NelthDocuments :
 *
 *   mount(el)   — monte l'application React dans l'hôte du panneau
 *   unmount()   — démonte proprement
 *   open(id)    — ouvre un document (chargé via /api/v1/documents/:id)
 *   close()     — réinitialise l'état interne (le pont replie le panneau)
 *
 * Le bouton retour du workspace demande la fermeture au pont
 * (window.__nelthDocsBridge.close) ; à défaut, repli sur close() local.
 */

import { createRoot } from 'react-dom/client';
import { DocumentsApp, type DocumentsController } from './app';

type MountApi = {
  mount(el: HTMLElement): void;
  unmount(): void;
  open(documentId: string): void;
  close(): void;
};

declare global {
  interface Window {
    NelthDocuments?: MountApi;
    /** Pont SPA — objet { close() } (repli : garde booléen d'un autre pont). */
    __nelthDocsBridge?: { close(): void } | boolean | undefined;
  }
}

let root: ReturnType<typeof createRoot> | null = null;
let mountedEl: HTMLElement | null = null;
let controller: DocumentsController | null = null;
let queuedOpen: string | null = null;

/** Enregistrement du contrôleur exposé par la racine React. */
function register(ctrl: DocumentsController | null): void {
  controller = ctrl;
  if (ctrl && queuedOpen) {
    const id = queuedOpen;
    queuedOpen = null;
    ctrl.open(id);
  }
}

window.NelthDocuments = {
  mount(el: HTMLElement) {
    // L'hôte peut être remplacé par le routeur du SPA — un nouveau montage
    // recrée proprement la racine React.
    if (root && mountedEl !== el) {
      try {
        root.unmount();
      } catch {
        /* déjà démonté */
      }
      root = null;
    }
    if (!root) {
      root = createRoot(el);
      mountedEl = el;
    }
    controller = null;
    root.render(<DocumentsApp host={el} register={register} />);
  },

  unmount() {
    try {
      root?.unmount();
    } catch {
      /* déjà démonté */
    }
    root = null;
    mountedEl = null;
    controller = null;
    queuedOpen = null;
  },

  open(documentId: string) {
    if (!documentId) return;
    if (controller) controller.open(documentId);
    else queuedOpen = documentId; // livré au montage de la racine
  },

  close() {
    queuedOpen = null;
    controller?.close();
  },
};
