/*
 * Nelth-IA Images — bridge SPA (navigation centre-seulement).
 *
 * ARCHITECTURE (exigence critique « sidebar permanente ») :
 *  - L'application Open WebUI (SPA Svelte compilé) reste montée en
 *    permanence : sa barre latérale n'est JAMAIS rechargée, remplacée ni
 *    redessinée — on y injecte seulement une icône « Images » en clonant
 *    la structure exacte de l'item Workspace (alignement identique).
 *  - L'espace Images est un overlay positionné dans la zone centrale du
 *    shell (div.flex-1), couvrant uniquement le contenu : la sidebar,
 *    le thème, l'auth et les conversations du SPA sont intacts.
 *  - Navigation par hash (#/images) : aucun conflit avec le routeur
 *    SvelteKit ; back/forward fonctionne nativement via popstate.
 *    Cliquer un autre item du SPA (SvelteKit pushState) referme
 *    l'overlay — seule la zone centrale change, jamais la sidebar.
 *
 * Assets: /static/images/main.js (bundle React) + /static/images/app.css.
 */

(() => {
  'use strict';
  if (window.__nelthImagesBridge) return;
  window.__nelthImagesBridge = true;

  const HASH = '#/images';
  const SCRIPT_URL = '/static/images/main.js';
  const CSS_URL = '/static/images/app.css';

  // Lucide « image » (trait 2px, arrondi) — même gabarit que les autres
  // icônes du rail ; la classe de l'icône d'origine est conservée.
  const IMAGE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="1.6"/>' +
    '<path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>';

  let active = false;
  let overlayEl = null;
  let mainEl = null;
  let origPosition = '';
  let inerted = [];
  let openedByUs = false;

  // ------------------------------------------------------------------
  // Synchronisation URL — toute navigation (SvelteKit pushState/replaceState
  // patchés, popstate, hashchange) repasse par sync().
  // ------------------------------------------------------------------
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      sync();
    });
  }
  for (const name of ['pushState', 'replaceState']) {
    const orig = History.prototype[name];
    History.prototype[name] = function (...args) {
      const result = orig.apply(this, args);
      schedule();
      return result;
    };
  }
  window.addEventListener('popstate', schedule);
  window.addEventListener('hashchange', schedule);

  function isImages() {
    return location.hash === HASH || location.hash === '#images';
  }
  function sync() {
    const want = isImages();
    if (want === active) return;
    if (want) open();
    else close();
  }

  // ------------------------------------------------------------------
  // Icônes « Images » dans la sidebar du SPA (rail + drawer).
  // Clonage de la structure Workspace → alignement exactement identique.
  // ------------------------------------------------------------------
  function swapSvg(a, label) {
    const svg = a.querySelector('svg');
    if (svg) {
      const wrap = document.createElement('div');
      wrap.innerHTML = IMAGE_SVG.trim();
      const fresh = wrap.firstElementChild;
      if (fresh) {
        const cls = svg.getAttribute('class');
        if (cls) fresh.setAttribute('class', cls);
        fresh.setAttribute('aria-hidden', 'true');
        svg.replaceWith(fresh);
      }
    }
    a.setAttribute('aria-label', label);
    a.setAttribute('draggable', 'false');
  }

  function hijackClick(a) {
    // rel="external" : SvelteKit n'intercepte PAS ce lien (son listener
    // capture-phase au niveau document voit le clic mais l'ignore) — la
    // navigation est 100% contrôlée ici, en hash, sans re-render du routeur.
    a.setAttribute('rel', 'external');
    a.addEventListener(
      'click',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isImages()) return;
        openedByUs = true;
        location.hash = '/images'; // hashchange → sync() → open()
      },
      true
    );
  }

  function injectSidebarIcons() {
    if (!document.body) return;

    // --- Rail (barre verticale 42px) : wrapper complet cloné ---
    const rail = document.getElementById('sidebar');
    if (rail && !document.getElementById('images-rail')) {
      const anchor = rail.querySelector(
        'a[aria-label="Workspace"], a[aria-label="Espace de travail"], a[href="/workspace"]'
      );
      if (anchor) {
        // Structure : div(wrapper) > div.flex > a
        const flexRow = anchor.parentElement;
        const outer = flexRow ? flexRow.parentElement : null;
        if (outer && outer !== anchor && outer.contains(anchor)) {
          const clone = outer.cloneNode(true);
          clone.id = 'images-rail';
          const a = clone.querySelector('a');
          if (a) {
            a.setAttribute('href', HASH);
            swapSvg(a, 'Images');
            hijackClick(a);
            outer.after(clone);
          }
        } else if (flexRow && flexRow !== anchor) {
          // Filet de sécurité structure différente : insérer après la ligne.
          const clone = flexRow.cloneNode(true);
          clone.id = 'images-rail';
          const a = clone.querySelector('a');
          if (a) {
            a.setAttribute('href', HASH);
            swapSvg(a, 'Images');
            hijackClick(a);
            flexRow.after(clone);
          }
        }
      }
    }

    // --- Drawer (menu épinglé) : item complet cloné (#workspace) ---
    const list = document.getElementById('pinned-menu-items-list');
    if (list && !document.getElementById('images-nav')) {
      const ws = list.querySelector('#workspace') || list.querySelector('a[href="/workspace"]')?.closest('div');
      if (ws) {
        const clone = ws.cloneNode(true);
        clone.id = 'images-nav';
        const a = clone.querySelector('a');
        if (a) {
          a.setAttribute('href', HASH);
          swapSvg(a, 'Images');
          // Libellé : dernier nœud textuel non vide → « Images »
          const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
          let textNode = null;
          let next;
          while ((next = walker.nextNode())) {
            if (next.nodeValue && next.nodeValue.trim()) textNode = next;
          }
          if (textNode) textNode.nodeValue = 'Images';
          hijackClick(a);
          ws.after(clone);
        }
      }
    }
    syncActiveStyle();
  }

  function iconNodes() {
    const railInner = document.querySelector('#images-rail a div');
    const drawer = document.getElementById('images-nav');
    return { railInner, drawer };
  }
  function syncActiveStyle() {
    const { railInner, drawer } = iconNodes();
    if (railInner) {
      railInner.classList.toggle('bg-gray-100', active);
      railInner.classList.toggle('dark:bg-gray-900', active);
    }
    if (drawer) {
      drawer.classList.toggle('bg-gray-100', active);
      drawer.classList.toggle('dark:bg-gray-900', active);
    }
  }

  // ------------------------------------------------------------------
  // Overlay central — la zone principale du shell, jamais la sidebar.
  // ------------------------------------------------------------------
  function findMainRegion() {
    // Zone centrale du shell SPA : #chat-container (persistant — le routeur
    // SvelteKit y rend chat / notes / workspace ; la sidebar reste à gauche).
    const chat = document.getElementById('chat-container');
    if (chat) return chat;
    // Filet de sécurité : premier frère flex-1 du rail.
    const rail = document.getElementById('sidebar');
    if (!rail) return null;
    const shell = rail.parentElement;
    if (!shell) return null;
    for (const el of shell.children) {
      if (el instanceof HTMLElement && el !== rail && el.classList.contains('flex-1')) {
        return el;
      }
    }
    return null;
  }

  function applyInert() {
    if (!mainEl || !overlayEl) return;
    for (const el of mainEl.children) {
      if (el === overlayEl) continue;
      if (!el.hasAttribute('inert')) {
        el.setAttribute('inert', '');
        el.setAttribute('aria-hidden', 'true');
        inerted.push(el);
      }
    }
  }

  function ensureCss() {
    if (document.getElementById('nelth-images-css')) return;
    const link = document.createElement('link');
    link.id = 'nelth-images-css';
    link.rel = 'stylesheet';
    link.href = CSS_URL;
    document.head.appendChild(link);
  }

  function ensureScript(cb) {
    const existing = document.getElementById('nelth-images-js');
    if (existing && window.NelthImages) {
      cb();
      return;
    }
    if (existing) {
      existing.addEventListener('load', cb, { once: true });
      return;
    }
    const s = document.createElement('script');
    s.id = 'nelth-images-js';
    s.src = SCRIPT_URL;
    s.defer = true;
    s.addEventListener('load', cb, { once: true });
    document.head.appendChild(s);
  }

  function open() {
    if (active) {
      if (overlayEl && overlayEl.isConnected) return;
      // Désynchronisation : le routeur SPA a remplacé le conteneur central
      // avec notre overlay dedans → purge puis re-montage immédiat.
      hardReset();
    }
    active = true;
    mainEl = findMainRegion();
    if (!mainEl) {
      active = false; // le shell n'est pas prêt — retenté au prochain tick
      return;
    }
    origPosition = mainEl.style.position || '';
    mainEl.style.position = 'relative';

    overlayEl = document.createElement('div');
    overlayEl.id = 'nelth-images-overlay';
    overlayEl.setAttribute('role', 'region');
    overlayEl.setAttribute('aria-label', 'Images');
    overlayEl.style.cssText =
      'position:absolute;inset:0;z-index:40;display:flex;flex-direction:column;' +
      'overflow:hidden;background:#FFFFFF;opacity:0;transition:opacity .18s ease';
    mainEl.appendChild(overlayEl);
    requestAnimationFrame(() => {
      if (overlayEl) overlayEl.style.opacity = '1';
    });

    applyInert();
    const mo = new MutationObserver(() => {
      if (active) applyInert();
    });
    mo.observe(mainEl, { childList: true });
    overlayEl.__mo = mo;

    ensureCss();
    ensureScript(() => {
      if (!overlayEl || !active) return;
      try {
        window.NelthImages?.mount(overlayEl);
      } catch (e) {
        console.warn('[images] mount failed', e);
      }
    });
    syncActiveStyle();
  }

  function hardReset() {
    if (overlayEl && overlayEl.__mo) {
      try {
        overlayEl.__mo.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (overlayEl) {
      const node = overlayEl;
      node.remove();
      overlayEl = null;
    }
    for (const el of inerted) {
      el.removeAttribute('inert');
      el.removeAttribute('aria-hidden');
    }
    inerted = [];
    if (mainEl) {
      mainEl.style.position = origPosition;
      mainEl = null;
    }
    active = false;
  }

  function close() {
    if (!active) return;
    active = false;
    openedByUs = false;
    if (overlayEl && overlayEl.__mo) {
      try {
        overlayEl.__mo.disconnect();
      } catch {
        /* ignore */
      }
    }
    try {
      window.NelthImages?.unmount();
    } catch {
      /* ignore */
    }
    for (const el of inerted) {
      el.removeAttribute('inert');
      el.removeAttribute('aria-hidden');
    }
    inerted = [];
    if (overlayEl) {
      const node = overlayEl;
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 180);
      overlayEl = null;
    }
    if (mainEl) {
      mainEl.style.position = origPosition;
      mainEl = null;
    }
    syncActiveStyle();
  }

  // L'app React émet cet événement quand Escape n'a rien d'ouvert à fermer.
  window.addEventListener('nelth:images:close', () => {
    if (!active) return;
    if (openedByUs && window.history.length > 1) {
      window.history.back(); // retour d'interaction → restaure l'état précédent
    } else if (isImages()) {
      location.hash = ''; // deep-load → sortie propre sans quitter le site
    } else {
      close();
    }
  });

  // ------------------------------------------------------------------
  // Boot : injection (le SPA hydratant asynchronement, on sonde doucement)
  // + ouverture si deep-link #/images.
  // ------------------------------------------------------------------
  function tick() {
    injectSidebarIcons();
    if (isImages()) open(); // idempotent + auto-réparation
    else if (active) close();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => tick());
  } else {
    tick();
  }
  setInterval(tick, 2000);
})();
