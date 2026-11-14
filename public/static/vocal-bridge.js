/**
 * Nelth-AI — Vocal bridge (dictée @untemps/react-vocal dans le composeur).
 *
 * Intègre la librairie @untemps/react-vocal DANS le SPA existant (Open WebUI
 * compilé), SANS second bouton micro :
 *
 *   1. Le pont détourne le bouton « Dicter » NATIF du composeur
 *      (#voice-input-button) — capture au niveau document AVANT le handler
 *      natif du SPA (même technique éprouvée que voice-bridge.js pour le
 *      bouton « Mode vocal »). Clic = démarre / arrête la dictée.
 *   2. La reconnaissance est gérée par useVocal (librairie officielle,
 *      moteur Web Speech par défaut — AUCUN moteur custom, AUCUN nouveau
 *      fournisseur STT). Interim → pilule de statut ; final → insertion
 *      dans le composeur #chat-input. JAMAIS envoyé au LLM automatiquement.
 *   3. Support : le bundle est préchargé à l'idle ; si isSupported() est
 *      faux (Web Speech indisponible, ex. Firefox), le bouton natif garde
 *      son comportement d'origine — aucun bouton mort affiché.
 *   4. Navigation / onglet caché → la dictée s'arrête (jamais de micro
 *      qui traîne en arrière-plan).
 *
 * Le mode vocal temps réel (voice-bridge.js + STT distant) est INTACT —
 * ce pont ne touche QUE le dicté du composeur.
 */

(() => {
  if (window.__nelthVocalBridge) return;
  window.__nelthVocalBridge = true;

  var BUILD = '20270114a1';
  var SCRIPT_URL = '/static/vocal/main.js?v=' + BUILD;
  var CSS_URL = '/static/vocal/app.css?v=' + BUILD;
  var ROOT_ID = 'nelth-vocal-root';

  var armed = false; // bundle chargé + isSupported() vrai → le clic est détourné
  var loading = false;
  var sessionActive = false; // miroir de l'état publié par l'app React

  // ---------------------------------------------------------------------
  // Styles : état actif sur le bouton « Dicter » natif (langage visuel du
  // bouton vocal détourné — violet #7c3aed, même famille).
  // ---------------------------------------------------------------------

  function ensureStyles() {
    if (document.getElementById('nelth-vocal-bridge-style')) return;
    var style = document.createElement('style');
    style.id = 'nelth-vocal-bridge-style';
    style.textContent = [
      // Racine du mont React (position:static — la pilule est en fixed).
      '#' + ROOT_ID + '{position:static;}',
      // État actif du bouton dicté natif pendant la session.
      'button#voice-input-button.nelth-vocal-active{color:#7c3aed !important;background:rgba(124,58,237,.12) !important;}',
      'html.dark button#voice-input-button.nelth-vocal-active{color:#a78bfa !important;background:rgba(167,139,250,.16) !important;}',
    ].join('\n');
    document.head.appendChild(style);
  }

  function ensureCss() {
    if (document.getElementById('nelth-vocal-css')) return;
    var link = document.createElement('link');
    link.id = 'nelth-vocal-css';
    link.rel = 'stylesheet';
    link.href = CSS_URL;
    document.head.appendChild(link);
  }

  // ---------------------------------------------------------------------
  // Mont du bundle React (une seule fois — mont persistant, sessions
  // open/close par-dessus ; l'instance useVocal vit pour la page).
  // ---------------------------------------------------------------------

  function mountRoot() {
    var el = document.getElementById(ROOT_ID);
    if (el) el.remove();
    el = document.createElement('div');
    el.id = ROOT_ID;
    document.body.appendChild(el);
    try {
      window.NelthVocal?.mount(el, {
        onState: function (state) {
          sessionActive = !!state && state.phase !== 'idle';
          syncButtonState();
        },
      });
    } catch (e) {
      console.warn('[vocal] mount failed', e);
      armed = false;
    }
  }

  function syncButtonState() {
    var btn = document.getElementById('voice-input-button');
    if (!btn) return;
    if (sessionActive) btn.classList.add('nelth-vocal-active');
    else btn.classList.remove('nelth-vocal-active');
  }

  // ---------------------------------------------------------------------
  // Préchargement à l'idle : le bundle arrive AVANT le premier clic
  // possible → l'état isSupported() est connu, le détour est armé.
  // ---------------------------------------------------------------------

  function preload() {
    if (loading || window.NelthVocal) {
      checkAndArm();
      return;
    }
    loading = true;
    ensureStyles();
    ensureCss();
    var s = document.createElement('script');
    s.id = 'nelth-vocal-js';
    s.src = SCRIPT_URL;
    s.defer = true;
    s.addEventListener(
      'load',
      function () {
        loading = false;
        checkAndArm();
      },
      { once: true }
    );
    s.addEventListener(
      'error',
      function () {
        loading = false; // pas de bundle → le bouton natif reste natif
      },
      { once: true }
    );
    document.head.appendChild(s);
  }

  function checkAndArm() {
    if (armed) return;
    try {
      if (window.NelthVocal && typeof window.NelthVocal.isSupported === 'function' && window.NelthVocal.isSupported()) {
        armed = true;
        mountRoot();
      }
    } catch (e) {
      console.warn('[vocal] support check failed', e);
    }
  }

  // Re-check on demand: a late-loading polyfill/engine can enable the
  // integration after boot (public event, no internal state exposed).
  window.addEventListener('nelth:vocal-recheck', checkAndArm);

  // ---------------------------------------------------------------------
  // Détour du clic « Dicter » — capture au plus tôt (niveau document) : le
  // clic n'atteint JAMAIS le handler natif du SPA quand le pont est armé.
  // Insensible aux re-renders du SPA (délégation document).
  // ---------------------------------------------------------------------

  document.addEventListener(
    'click',
    function (e) {
      if (!armed) return; // bundle pas prêt / non supporté → comportement natif
      var btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!btn || btn.id !== 'voice-input-button') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      toggle();
    },
    true
  );

  function toggle() {
    if (sessionActive) closeDictation();
    else openDictation();
  }

  function openDictation() {
    try {
      window.NelthVocal?.open();
    } catch (e) {
      console.warn('[vocal] open failed', e);
    }
  }

  function closeDictation() {
    try {
      window.NelthVocal?.close();
    } catch (e) {
      console.warn('[vocal] close failed', e);
    }
  }

  // ---------------------------------------------------------------------
  // Hygiène : navigation (SPA push/pop) ou onglet caché → dictée stoppée.
  // (L'app React gère déjà visibilitychange ; ici : navigation + double
  //  filet sécurité.)
  // ---------------------------------------------------------------------

  ['pushState', 'replaceState'].forEach(function (name) {
    var orig = window.history[name];
    if (typeof orig !== 'function') return;
    window.history[name] = function () {
      var result = orig.apply(this, arguments);
      if (sessionActive) closeDictation();
      return result;
    };
  });
  window.addEventListener('popstate', function () {
    if (sessionActive) closeDictation();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden' && sessionActive) closeDictation();
  });

  // Boot : préchargement dès que le navigateur est disponible.
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(preload, { timeout: 2500 });
  } else {
    setTimeout(preload, 900);
  }
})();
