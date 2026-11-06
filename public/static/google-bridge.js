/**
 * Nelth-AI — Google one-click bridge (popup Firebase, zéro page intermédiaire).
 *
 * Le bouton « Continue with Google » du frontend Open WebUI d'origine navigue
 * vers /oauth/google/login (flux OAuth classique par code). Quand les clés
 * GOOGLE_CLIENT_ID/SECRET sont absentes mais que le pont Firebase est actif,
 * /api/config annonce  oauth.providers.google = { mode: 'firebase-popup', firebase: {...} }.
 * Ce script intercepte alors le clic EN PHASE DE CAPTURE (avant le handler du
 * bundle) et ouvre directement le popup Google avec le geste utilisateur
 * encore actif : UN SEUL clic, aucune page intermédiaire.
 *
 * Fin de flux : POST /oauth/google/firebase-token (vérification serveur de
 * l'ID token signé Google) → cookie de session → /auth, où le SPA d'origine
 * prend le relais (cookie → localStorage → entrée dans l'application).
 *
 * Chutes en secours :
 *   • popup bloqué / environnement mobile → /oauth/google/login?auto=1
 *     (redirection pleine page, consommée au retour par getRedirectResult) ;
 *   • toute autre erreur → /oauth/google/login?err=<message> (page pont qui
 *     affiche le message et permet de réessayer) ;
 *   • config non encore chargée au clic → navigation normale vers la page
 *     pont (comportement deux-clics d'origine, jamais bloquant).
 */
(() => {
  if (window.__nelthGoogleBridge) return;
  window.__nelthGoogleBridge = true;

  var FIREBASE_APP = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
  var FIREBASE_AUTH = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

  var mode = null;
  var fbCfg = null;
  var busy = false;

  // Ressemble la config (le SPA appelle déjà /api/config au boot ; ici c'est
  // mis en cache par le navigateur, coût quasi nul).
  fetch('/api/config', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      var g = cfg && cfg.oauth && cfg.oauth.providers && cfg.oauth.providers.google;
      if (g && g.mode === 'firebase-popup' && g.firebase && g.firebase.apiKey) {
        mode = 'firebase-popup';
        fbCfg = g.firebase;
      }
    })
    .catch(function () { /* flux OAuth classique */ });

  function isAuthPage() {
    var p = window.location.pathname.replace(/\/+$/, '');
    return p === '' || p === '/auth';
  }

  document.addEventListener(
    'click',
    function (ev) {
      if (busy || mode !== 'firebase-popup' || !isAuthPage()) return;
      if (ev.defaultPrevented || ev.button !== 0 || ev.ctrlKey || ev.metaKey) return;
      var t = ev.target;
      var el = t && t instanceof Element ? t.closest('button, [role="button"], a') : null;
      if (!el || !/google/i.test(el.textContent || '')) return;

      // C'est le bouton « Continue with Google » : on intercepte AVANT le
      // handler du bundle (stopPropagation en capture) et on ouvre le popup
      // ici, pendant que le geste utilisateur est encore actif.
      ev.stopPropagation();
      ev.preventDefault();
      run(el);
    },
    true
  );

  function run(btn) {
    busy = true;
    var prevOpacity = btn.style.opacity;
    var prevPointer = btn.style.pointerEvents;
    btn.style.opacity = '0.6';
    btn.style.pointerEvents = 'none';

    Promise.all([import(FIREBASE_APP), import(FIREBASE_AUTH)])
      .then(function (mods) {
        var app = mods[0].initializeApp(fbCfg);
        var auth = mods[1].getAuth(app);
        return mods[1].signInWithPopup(auth, new mods[1].GoogleAuthProvider());
      })
      .then(function (cred) {
        return cred.user.getIdToken();
      })
      .then(function (idToken) {
        return fetch('/oauth/google/firebase-token', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ idToken: idToken })
        }).then(function (res) {
          return res.ok
            ? res.json()
            : res.json().then(function (data) {
                throw new Error((data && data.detail) || 'La connexion a échoué.');
              }, function () { throw new Error('La connexion a échoué.'); });
        });
      })
      .then(function (data) {
        // Le SPA d'origine prend le relais sur /auth : cookie token →
        // localStorage → redirection vers l'application.
        window.location.href = data && data.pending ? '/auth?pending=1' : '/auth';
      })
      .catch(function (e) {
        busy = false;
        btn.style.opacity = prevOpacity;
        btn.style.pointerEvents = prevPointer;
        var code = e && e.code ? String(e.code) : '';
        if (code === 'auth/popup-blocked' ||
            code === 'auth/operation-not-supported-in-this-environment') {
          // Mobile / popup bloqué : redirection pleine page (sans geste requis).
          window.location.href = '/oauth/google/login?auto=1';
          return;
        }
        if (code === 'auth/popup-closed-by-user' ||
            code === 'auth/cancelled-popup-request') {
          return; // l'utilisateur a refermé la fenêtre, on ne dit rien
        }
        window.location.href =
          '/oauth/google/login?err=' +
          encodeURIComponent((e && e.message) || 'Erreur Google.');
      });
  }
})();
