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
 * NAVIGATION (config canonique unique — voir NAV ci-dessous) :
 *  - Le SPA compilé rend DEUX variantes de sidebar, toutes deux susceptibles
 *    de porter l'id générique « sidebar » : le RAIL replié (42 px, icônes) et
 *    le TIROIR étendu (contient #pinned-menu-items-list). La résiliation des
 *    cibles ne passe JAMAIS par cet id ambigu : le rail = l'élément #sidebar
 *    SANS liste épinglée ; le tiroir = l'hôte de #pinned-menu-items-list.
 *  - Chaque injection est GARDE par son conteneur (présence vérifiée DANS la
 *    cible), les clones sont NETTOYÉS de leurs ids (jamais de doublon
 *    documentaire) et re-marqués avec des ids stables. Une passe
 *    d'assainissement retire à chaque tick tout clone obsolète ou déplacé :
 *    impossible d'accumuler des entrées dupliquées (Notes / Espace de
 *    travail / Images) d'un cycle replié↔étendu à l'autre.
 *  - Sélecteurs structuraux (ids #sidebar-workspace-button, #workspace) —
 *    insensibles à la locale (EN/FR) et au libellé aria traduit.
 *
 * Assets: /static/images/main.js (bundle React) + /static/images/app.css.
 */

(() => {
  'use strict';
  if (window.__nelthImagesBridge) return;
  window.__nelthImagesBridge = true;

  const HASH = '#/images';
  // Versionnée : garantit que les navigateurs laissent tomber l'ancien bundle
  // après une mise à jour (les artefacts sont committés dans public/).
  // 20261111a1 — fix tremblement du composeur au défilement : ancre de
  // défilement désactivée (.images-scroll) + hystérésis du compactage.
  // 20261111a2 — ligne de séparation remplacée par un fondu translucide
  // flouté sous l'en-tête compact (suit le thème clair/sombre).
  // 20261112a1 — composeur V2 : catégorie Image|Vidéo|GIF, segment
  // Nelth-V2|Nelth-V3 (badge NEW bleu), 480p|720p, variations 1-4,
  // ratio Auto (image→image V2 / image→vidéo) + rendu vidéo des items.
  // 20261112a2 — barre d'outils UNE SEULE LIGNE : plus jamais de
  // deuxième ligne pour micro/envoyer (flex-nowrap, ml-auto, shrink-0) ;
  // chips défilantes horizontalement sur écran étroit.
  const BUILD = '20261112a2';
  const SCRIPT_URL = '/static/images/main.js?v=' + BUILD;
  const CSS_URL = '/static/images/app.css?v=' + BUILD;

  // ------------------------------------------------------------------
  // Config canonique de navigation — SOURCE UNIQUE de vérité.
  // Une seule entrée « Images » ; ids stables et conteneurs canoniques.
  // ------------------------------------------------------------------
  const NAV = {
    images: {
      hash: HASH,
      label: 'Images',
      // Rail replié : le clone vit DANS le conteneur -gap-0.5 du rail.
      rail: { wrapper: 'images-rail', anchor: 'sidebar-images-rail-button' },
      // Tiroir étendu : le clone vit en SŒUR IMMÉDIATE de la liste épinglée
      // (jamais À L'INTÉRIEUR → hors du SortableJS de la liste, et insensible
      // aux réconciliations du each-block Svelte).
      drawer: { wrapper: 'images-nav', anchor: 'sidebar-images-drawer-button' }
    }
  };

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
  // Résolution STRUCTURELLE des deux variantes de sidebar.
  // L'id « sidebar » désigne le rail replié OU le tiroir étendu selon l'état :
  // jamais un moyen fiable de les distinguer. Le tiroir porte TOUJOURS la
  // liste épinglée (#pinned-menu-items-list) ; le rail jamais.
  // ------------------------------------------------------------------
  function drawerList() {
    return document.getElementById('pinned-menu-items-list');
  }
  function railEl() {
    const sb = document.getElementById('sidebar');
    // Le rail : la variante #sidebar qui n'héberge PAS la liste épinglée.
    // (Tiroir étendu → #sidebar EST le tiroir → le rail est démonté.)
    return sb && !sb.contains(drawerList()) && sb.querySelector('a') ? sb : null;
  }

  // ------------------------------------------------------------------
  // Assainissement : un clone n'existe qu'à sa place canonique.
  // Toute instance obsolète (héritée d'un cycle corrompu, déplacée par une
  // réconciliation Svelte, ou imbriquée dans un autre clone) est détruite —
  // c'est ce qui garantit qu'aucune entrée de navigation ne se duplique
  // jamais, même après des heures de replier/déplier.
  // ------------------------------------------------------------------
  function decontaminate() {
    // Tiroir : exactement une sœur « images-nav » juste après la liste.
    document.querySelectorAll('#' + NAV.images.drawer.wrapper).forEach((el) => {
      const list = drawerList();
      if (!list || el.previousElementSibling !== list) el.remove();
    });
    // Rail : exactement un « images-rail » À L'INTÉRIEUR du rail actif.
    document.querySelectorAll('#' + NAV.images.rail.wrapper).forEach((el) => {
      const rail = railEl();
      if (!rail || !rail.contains(el)) el.remove();
    });
  }

  // ------------------------------------------------------------------
  // Icônes « Images » dans la sidebar du SPA (rail + tiroir).
  // Clonage de la structure Workspace → alignement exactement identique.
  // ------------------------------------------------------------------
  function stripIds(root) {
    // Aucun clone ne peut introduire de doublon d'id documentaire :
    // les ids hérités du gabarit (sidebar-workspace-button…) disparaissent,
    // seuls nos ids stables sont posés après.
    root.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  }

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

  function rewriteLabel(a, label) {
    // Dernier nœud textuel non vide du lien → libellé visible « Images ».
    const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
    let textNode = null;
    let next;
    while ((next = walker.nextNode())) {
      if (next.nodeValue && next.nodeValue.trim()) textNode = next;
    }
    if (textNode) textNode.nodeValue = label;
  }

  // Sur mobile, la navigation du SPA referme le tiroir-overlay (réaction
  // compilée au changement de route) — notre navigation en hash ne la déclenche
  // pas : on REFERME donc explicitement le tiroir via le bouton compilé, pour
  // préserver exactement le comportement « close on navigation » des autres
  // entrées. Desktop : le tiroir reste ouvert (sidebar persistante, la zone
  // centrale s'ajuste — cf. custom.css §4b).
  function closeMobileDrawer() {
    if (!window.matchMedia('(max-width: 767px)').matches) return;
    const toggle =
      document.getElementById('sidebar-toggle-button') ||
      document.querySelector('div[role="navigation"] button[aria-label="Close Sidebar"]');
    if (toggle) toggle.click();
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
        closeMobileDrawer();
      },
      true
    );
  }

  function decorate(clone, anchorId, label) {
    const a = clone.querySelector('a');
    if (!a) return false;
    a.id = anchorId;
    a.setAttribute('href', HASH);
    swapSvg(a, label);
    rewriteLabel(a, label);
    hijackClick(a);
    return true;
  }

  // --- Rail replié : une rangée clonée, insérée après la rangée Workspace ---
  function injectRailIcon() {
    const rail = railEl();
    if (!rail) return; // étendu → rail démonté : rien à faire
    if (rail.querySelector('#' + NAV.images.rail.wrapper)) return; // déjà là

    // Rangée d'ancrage : Workspace (ids stables du bundle, insensibles à la
    // locale) puis repli aria/href.
    const anchor =
      rail.querySelector('#sidebar-workspace-button') ||
      rail.querySelector('a[aria-label="Workspace"], a[aria-label="Espace de travail"]') ||
      rail.querySelector('a[href="/workspace"]') ||
      rail.querySelector('#sidebar-notes-button');
    if (!anchor) return;

    // Structure du rail : div(rangée, sans classe) > div.flex > a.
    const flexRow = anchor.parentElement;
    let outer = flexRow && flexRow.parentElement;
    if (!outer || outer === anchor || !outer.contains(anchor)) outer = flexRow;

    const clone = outer.cloneNode(true);
    stripIds(clone);
    clone.id = NAV.images.rail.wrapper;
    if (!decorate(clone, NAV.images.rail.anchor, NAV.images.label)) return;
    outer.after(clone);
  }

  // --- Tiroir étendu : un item cloné, SŒUR de la liste (jamais dedans) ---
  function injectDrawerIcon() {
    const list = drawerList();
    if (!list) return; // tiroir démonté (mobile?) : rien à faire
    if (list.nextElementSibling && list.nextElementSibling.id === NAV.images.drawer.wrapper) {
      return; // déjà en place
    }

    // Item d'ancrage dans la liste épinglée : Workspace d'abord.
    const ws =
      list.querySelector('#workspace') ||
      list.querySelector('#sidebar-workspace-button')?.closest('div') ||
      list.querySelector('a[href="/workspace"]')?.closest('div') ||
      list.querySelector('#sidebar-notes-button')?.closest('div');
    if (!ws || !list.contains(ws)) return;

    const clone = ws.cloneNode(true);
    stripIds(clone);
    clone.id = NAV.images.drawer.wrapper;
    if (!decorate(clone, NAV.images.drawer.anchor, NAV.images.label)) return;
    // Sœur immédiate de la liste : hors SortableJS (l'utilisateur peut
    // réordonner les items épinglés sans jamais compter/réordonner notre
    // entrée) et hors réconciliation du each-block Svelte.
    list.after(clone);
  }

  function injectSidebarIcons() {
    if (!document.body) return;
    decontaminate();
    injectRailIcon();
    injectDrawerIcon();
    syncActiveStyle();
  }

  function iconNodes() {
    const railInner = document.querySelector(
      '#' + NAV.images.rail.wrapper + ' a div'
    );
    const drawer = document.getElementById(NAV.images.drawer.wrapper);
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
      'overflow:hidden;background:var(--images-bg,#FFFFFF);opacity:0;transition:opacity .18s ease';
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
  //
  // Deux moteurs complémentaires :
  //  1. MutationObserver ciblé — réagit AU FRAME PRÈS au montage/remontage
  //     des variantes de sidebar (rail ↔ tiroir) : l'icône « Images » (et
  //     l'assainissement des clones obsolètes) est immédiate après chaque
  //     bascule, sans attendre le prochain tick. L'observateur n'écoute que
  //     les mutations qui TOUCHENT un conteneur de sidebar (div[role=
  //     navigation], #sidebar, #pinned-menu-items-list) — le reste du DOM
  //     (messages, galerie) ne le réveille jamais.
  //  2. Tick 2 s — filet de sécurité idempotent (hydratation asynchrone,
  //     réconciliations Svelte inattendues, auto-réparation).
  // ------------------------------------------------------------------
  function tick() {
    injectSidebarIcons();
    if (isImages()) open(); // idempotent + auto-réparation
    else if (active) close();
  }

  function sidebarMutation(m) {
    if (m.type !== 'childList') return false;
    const relevant = (el) =>
      el instanceof HTMLElement &&
      ((el.id && (el.id === 'sidebar' || el.id === 'pinned-menu-items-list' || el.id === 'sidebar-resizer')) ||
        el.getAttribute('role') === 'navigation' ||
        (el.id === 'images-rail' || el.id === 'images-nav'));
    if (relevant(m.target)) return true;
    return [...m.addedNodes, ...m.removedNodes].some(relevant);
  }

  let moScheduled = false;
  function armSidebarObserver() {
    const shell = document.querySelector('.app');
    if (!shell) {
      // le shell hydrate plus tard — retenter au prochain tick
      setTimeout(armSidebarObserver, 1000);
      return;
    }
    const mo = new MutationObserver((muts) => {
      if (!muts.some(sidebarMutation)) return;
      if (moScheduled) return;
      moScheduled = true;
      requestAnimationFrame(() => {
        moScheduled = false;
        injectSidebarIcons();
      });
    });
    mo.observe(shell, { childList: true, subtree: true });
  }
  armSidebarObserver();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => tick());
  } else {
    tick();
  }
  setInterval(tick, 2000);
})();
