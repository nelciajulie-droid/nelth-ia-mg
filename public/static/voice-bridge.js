/**
 * Nelth-AI — Voice bridge (mode vocal temps réel, à la ChatGPT Advanced Voice).
 *
 * Intègre l'overlay vocal DANS le SPA existant (Open WebUI compilé) :
 *
 *   1. Bouton « Vocal » injecté dans la rangée de contrôles du composeur
 *      (icône + libellé aria) — visible pour les comptes ET les invités.
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

  var BUILD = '20270108a1';
  var SCRIPT_URL = '/static/voice/main.js?v=' + BUILD;
  var CSS_URL = '/static/voice/app.css?v=' + BUILD;
  var BUTTON_ID = 'nelth-voice-button';
  var OVERLAY_ID = 'nelth-voice-overlay';

  var active = false;
  var overlayEl = null;

  // ---------------------------------------------------------------------
  // Button (composer controls row)
  // ---------------------------------------------------------------------

  function ensureStyles() {
    if (document.getElementById('nelth-voice-bridge-style')) return;
    var style = document.createElement('style');
    style.id = 'nelth-voice-bridge-style';
    style.textContent = [
      '#' + BUTTON_ID + '{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:9999px;border:1px solid rgba(0,0,0,.1);background:transparent;color:#374151;cursor:pointer;transition:background-color .15s ease,border-color .15s ease;flex:none;}',
      'html.dark #' + BUTTON_ID + '{border-color:rgba(255,255,255,.14);color:#e5e7eb;}',
      '#' + BUTTON_ID + ':hover{background:rgba(124,58,237,.08);border-color:rgba(124,58,237,.35);color:#7c3aed;}',
      'html.dark #' + BUTTON_ID + ':hover{background:rgba(124,58,237,.18);color:#c4b5fd;}',
      '#' + BUTTON_ID + '.nelth-voice-active{background:#7c3aed;border-color:#7c3aed;color:#fff;}',
      '#' + BUTTON_ID + ' svg{width:18px;height:18px;}',
      '#' + OVERLAY_ID + '{position:absolute;inset:0;z-index:40;animation:nelth-voice-in .18s ease;}',
      '@keyframes nelth-voice-in{from{opacity:0}to{opacity:1}}',
    ].join('\n');
    document.head.appendChild(style);
  }

  var ICON_MIC =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';

  /** The composer's trailing controls row (mic / send buttons cluster). */
  function findControlsRow() {
    // Anchor: the chat textarea, then its enclosing footer → the row of
    // buttons that carries the audio-record control.
    var area = document.getElementById('chat-input') || document.querySelector('textarea[aria-label*="essage"], textarea[placeholder*="essage"]');
    if (!area) return null;
    var footer = area.closest('footer') || area.parentElement?.parentElement;
    if (!footer) return null;
    // Button rows inside the footer (bottom-most row with multiple buttons).
    var rows = footer.querySelectorAll('div[class*="flex"][class*="items-center"]');
    var best = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].querySelectorAll('button').length >= 2) best = rows[i];
    }
    return best || footer;
  }

  function ensureButton() {
    if (document.getElementById(BUTTON_ID)) return;
    var row = findControlsRow();
    if (!row) return;
    ensureStyles();
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = BUTTON_ID;
    btn.setAttribute('aria-label', 'Mode vocal — conversation temps réel');
    btn.title = 'Mode vocal';
    btn.innerHTML = ICON_MIC;
    btn.addEventListener('click', toggle);
    // Prepend: the voice mode is the leftmost action of the controls row.
    row.insertBefore(btn, row.firstChild);
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

    var btn = document.getElementById(BUTTON_ID);
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
    var btn = document.getElementById(BUTTON_ID);
    if (btn) btn.classList.remove('nelth-voice-active');
  }

  function toggle() {
    if (active) close();
    else open();
  }

  // ---------------------------------------------------------------------
  // Re-injection after SPA re-renders (composer row is recreated often)
  // ---------------------------------------------------------------------

  function startObserving() {
    if (!('MutationObserver' in window) || !document.body) return;
    var scheduled = false;
    var observer = new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      setTimeout(function () {
        scheduled = false;
        ensureButton();
      }, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

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
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        ensureButton();
        startObserving();
      });
    } else {
      ensureButton();
      startObserving();
    }
  }

  boot();
})();
