/**
 * Nelth-AI — Voice bridge (mode vocal temps réel, à la ChatGPT Advanced Voice).
 *
 * Intègre l'overlay vocal DANS le SPA existant (Open WebUI compilé) :
 *
 *   1. AUCUN nouveau bouton (correction utilisateur) : le pont détourne le
 *      bouton « Mode vocal » DU COMPOSEUR — celui déjà présent à côté du
 *      dicté (aria-label « Voice mode » EN / « Mode vocal » FR). Son clic est
 *      intercepté en phase de capture AVANT le handler natif du SPA : il
 *      ouvre l'overlay Nelth (comptes ET invités).
 *   2. Au clic : l'overlay React (bundle /static/voice/main.js, window.
 *      NelthVoice) monte DANS la zone centrale — la SIDEBAR reste montée
 *      et visible (exigence mission §12 / utilisateur).
 *   3. Mobile : le bouton « × » de l'overlay ramène au chat (unmount).
 *   4. Le bundle gère micro → POST /api/voice/audio (PCM16 16k mono) et la
 *      SSE /api/voice/events ; AUCUNE inférence navigateur (STT/LLM/TTS
 *      distants — voir src/lib/voice/*).
 *
 * Verrou invité : le mode vocal est OUVERT aux invités (correction
 * utilisateur) — aucune invite de connexion ici.
 */

(() => {
  if (window.__nelthVoiceBridge) return;
  window.__nelthVoiceBridge = true;

  var BUILD = '20270109b1';
  var SCRIPT_URL = '/static/voice/main.js?v=' + BUILD;
  var CSS_URL = '/static/voice/app.css?v=' + BUILD;
  var OVERLAY_ID = 'nelth-voice-overlay';

  var active = false;
  var overlayEl = null;

  // ---------------------------------------------------------------------
  // Bouton « Mode vocal » du composeur (détourné — PAS de nouveau bouton)
  // ---------------------------------------------------------------------

  function ensureStyles() {
    if (document.getElementById('nelth-voice-bridge-style')) return;
    var style = document.createElement('style');
    style.id = 'nelth-voice-bridge-style';
    style.textContent = [
      // État actif appliqué au bouton vocal NATIF pendant que l'overlay est
      // monté (pastille violette — !important contre les utilitaires Tailwind
      // du SPA : bg-black / dark:bg-white).
      'button.nelth-voice-active{background:#7c3aed !important;border-color:#7c3aed !important;color:#ffffff !important;}',
      'html.dark button.nelth-voice-active{background:#7c3aed !important;color:#ffffff !important;}',
      '#' + OVERLAY_ID + '{position:absolute;inset:0;z-index:40;animation:nelth-voice-in .18s ease;}',
      '@keyframes nelth-voice-in{from{opacity:0}to{opacity:1}}',
    ].join('\n');
    document.head.appendChild(style);
  }

  /** Le bouton vocal du composeur : étiquette localisée (« Voice mode » EN /
   *  « Mode vocal » FR) + filet structurel (pastille ronde sombre
   *  immédiatement à droite du dicté) pour toute autre locale. */
  function isAppVoiceButton(el) {
    var btn = el && el.closest ? el.closest('button') : null;
    if (!btn || btn.id === 'voice-input-button') return false;
    var label = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
    if (label === 'voice mode' || label === 'mode vocal') return true;
    return btn === structuralVoiceButton();
  }

  function findAppVoiceButton() {
    var b = document.querySelector(
      'button[aria-label="Voice mode"], button[aria-label="Mode vocal"]'
    );
    return b || structuralVoiceButton();
  }

  /** Filet structurel (locale inconnue) : premier bouton à droite du dicté,
   *  pastille ronde sombre (bg-black / dark:bg-white) — signature du bouton
   *  vocal natif du composeur. */
  function structuralVoiceButton() {
    var mic = document.getElementById('voice-input-button');
    if (!mic) return null;
    var sib = mic.nextElementSibling;
    while (sib && sib.tagName !== 'BUTTON') sib = sib.nextElementSibling;
    if (!sib) return null;
    var cls = typeof sib.className === 'string' ? sib.className : '';
    if (
      cls.indexOf('rounded-full') !== -1 &&
      (cls.indexOf('bg-black') !== -1 || cls.indexOf('dark:bg-white') !== -1)
    ) {
      return sib;
    }
    return null;
  }

  /** Capture AU PLUS TÔT (niveau document) : le clic du bouton vocal du SPA
   *  n'atteint JAMAIS son handler natif — il pilote l'overlay Nelth
   *  (ouvre / ferme). Résiste aux re-renders du SPA (délégation document). */
  function guardAppVoiceButton() {
    document.addEventListener(
      'click',
      function (e) {
        if (!isAppVoiceButton(e.target)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        toggle();
      },
      true
    );
  }

  // ---------------------------------------------------------------------
  // Overlay mount (center region — sidebar stays visible)
  // ---------------------------------------------------------------------

  function findMainRegion() {
    // Zone centrale du shell SPA : #chat-container (persistant — même ancre
    // que le pont Images ; la sidebar reste à gauche, visible).
    var chat = document.getElementById('chat-container');
    if (chat) return chat;
    // Filet de sécurité : premier frère flex-1 du rail.
    var rail = document.getElementById('sidebar');
    if (!rail || !rail.parentElement) return null;
    var children = rail.parentElement.children;
    for (var i = 0; i < children.length; i++) {
      var el = children[i];
      if (el instanceof HTMLElement && el !== rail && el.classList.contains('flex-1')) return el;
    }
    return null;
  }

  function ensureScript(cb) {
    var existing = document.getElementById('nelth-voice-js');
    if (existing && window.NelthVoice) {
      cb();
      return;
    }
    if (existing) {
      existing.addEventListener('load', cb, { once: true });
      return;
    }
    var s = document.createElement('script');
    s.id = 'nelth-voice-js';
    s.src = SCRIPT_URL;
    s.defer = true;
    s.addEventListener('load', cb, { once: true });
    document.head.appendChild(s);
  }

  function ensureCss() {
    if (document.getElementById('nelth-voice-css')) return;
    var link = document.createElement('link');
    link.id = 'nelth-voice-css';
    link.rel = 'stylesheet';
    link.href = CSS_URL;
    document.head.appendChild(link);
  }

  function open() {
    if (active) {
      if (overlayEl && overlayEl.isConnected) return;
      close();
    }
    var mainEl = findMainRegion();
    if (!mainEl) return; // shell not ready — retried on next mutation tick
    active = true;

    ensureStyles();
    var origPosition = mainEl.style.position || '';
    mainEl.style.position = origPosition === 'static' ? 'relative' : origPosition || 'relative';

    overlayEl = document.createElement('div');
    overlayEl.id = OVERLAY_ID;
    overlayEl.setAttribute('role', 'region');
    overlayEl.setAttribute('aria-label', 'Conversation vocale');
    mainEl.appendChild(overlayEl);

    ensureCss();
    ensureScript(function () {
      if (!overlayEl || !active) return;
      try {
        window.NelthVoice?.mount(overlayEl, {
          chatId: window.__nelthVoiceChatId || null,
          onClose: close,
        });
      } catch (e) {
        console.warn('[voice] mount failed', e);
        close();
      }
    });

    // Pastille violette sur le bouton vocal natif pendant la session.
    var btn = findAppVoiceButton();
    if (btn) btn.classList.add('nelth-voice-active');
  }

  function close() {
    active = false;
    try {
      window.NelthVoice?.unmount();
    } catch {
      /* already unmounted */
    }
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
    }
    // Le bouton natif peut avoir été re-rendu → nettoyer par classe.
    var btns = document.querySelectorAll('button.nelth-voice-active');
    for (var i = 0; i < btns.length; i++) btns[i].classList.remove('nelth-voice-active');
  }

  function toggle() {
    if (active) close();
    else open();
  }

  // ---------------------------------------------------------------------
  // Aucune ré-injection nécessaire : le détour du bouton natif se fait par
  // délégation au niveau document (guardAppVoiceButton) — insensible aux
  // re-renders du SPA (le composeur est recréé constamment).
  // ---------------------------------------------------------------------

  // Track the OPEN chat for conversation continuity (persist into it).
  function trackChatId() {
    try {
      var m = window.location.pathname.match(/^\/c\/([a-f0-9-]+)/i);
      window.__nelthVoiceChatId = m ? m[1] : null;
    } catch (e) {
      window.__nelthVoiceChatId = null;
    }
  }

  ['pushState', 'replaceState'].forEach(function (name) {
    var orig = window.history[name];
    if (typeof orig !== 'function') return;
    window.history[name] = function () {
      var result = orig.apply(this, arguments);
      trackChatId();
      if (active) close(); // leaving the chat view ends the voice session UI
      return result;
    };
  });
  window.addEventListener('popstate', function () {
    trackChatId();
    if (active) close();
  });

  function boot() {
    trackChatId();
    guardAppVoiceButton();
  }

  boot();
})();
