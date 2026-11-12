/**
 * Nelth-AI — Mode Invité (guest bridge), affichage à la ChatGPT.
 *
 * Rôle de ce script (chargé sur TOUTES les pages du SPA) :
 *
 *   1. Résout la session courante via /api/v1/auths/ et détecte si c'est un
 *      compte invité (email *@guests.nelth-ia.local — compte anonyme jetable
 *      provisionné par POST /api/v1/auths/guest, voir le handshake dans
 *      index.html <head>).
 *
 *   2. Si (et seulement si) la session est INVITÉE et qu'on n'est PAS sur la
 *      page /auth : injecte « Se connecter » + « S'inscrire » en haut à
 *      droite de la barre du SPA — exactement l'affichage ChatGPT. La page
 *      de login/signup reste INTACTE (aucun bouton invité dessus, conformité
 *      au souhait produit).
 *
 *   3. Clic sur un bouton : le token invité est mis de côté
 *      (sessionStorage) puis retiré → /auth?form=signin|signup s'ouvre
 *      proprement. Si l'utilisateur revient SANS se connecter, le handshake
 *      (index.html) RESTAURE la session invitée et ses conversations au lieu
 *      d'en recréer une neuve.
 *
 *   4. Hygiène de session : déconnexion détectée → stash vidé (le prochain
 *      passage sur / recrée un invité NEUF, comme ChatGPT) ; connexion réelle
 *      réussie → stash vidé ; JWT invité expiré (401) → rotation silencieuse
 *      vers un nouvel invité (une seule tentative par chargement).
 */
(() => {
  if (window.__nelthGuestBridge) return;
  window.__nelthGuestBridge = true;

  var GUEST_EMAIL_SUFFIX = '@guests.nelth-ia.local';
  var STASH_KEY = 'nelth-guest-stash';
  var ROTATE_FLAG = 'nelth-guest-rotated';

  var sessionInfo = null; // { guest, email, name } | null
  var lastSeenToken = null;

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  function getToken() {
    try {
      return localStorage.getItem('token') || null;
    } catch (e) {
      return null;
    }
  }

  function isAuthPage() {
    var p = window.location.pathname;
    return p === '/auth' || p.indexOf('/oauth') === 0 || p.indexOf('/forgot') === 0;
  }

  /** Décode le payload d'un JWT (aucune vérification — usage UI uniquement). */
  function jwtPayload(token) {
    try {
      var part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (part.length % 4) part += '=';
      return JSON.parse(atob(part));
    } catch (e) {
      return null;
    }
  }

  function looksLikeGuestJwt(token) {
    if (!token) return false;
    var p = jwtPayload(token);
    return !!(p && (p.auth_method === 'guest' || p.typ === 'session'));
  }

  function clearStash() {
    try {
      sessionStorage.removeItem(STASH_KEY);
    } catch (e) {
      /* private mode */
    }
  }

  // ---------------------------------------------------------------------
  // 1) Résolution de session
  // ---------------------------------------------------------------------

  function resolveSessionNow() {
    var token = getToken();
    lastSeenToken = token;
    if (!token) {
      sessionInfo = null;
      return Promise.resolve(null);
    }
    return fetch('/api/v1/auths/', {
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
    })
      .then(function (res) {
        if (res.status === 401) {
          // Session invité expirée/invalide → rotation silencieuse (UNE fois
          // par chargement : le garde anti-boucle évite tout ping-pong).
          if (looksLikeGuestJwt(token) && String(jwtPayload(token).auth_method) === 'guest') {
            try {
              if (!sessionStorage.getItem(ROTATE_FLAG)) {
                sessionStorage.setItem(ROTATE_FLAG, '1');
                localStorage.removeItem('token');
                window.location.replace(window.location.pathname + window.location.search);
                return null;
              }
            } catch (e) {
              /* private mode → laisser le SPA gérer l'expiration */
            }
          }
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then(function (d) {
        if (!d || !d.email) {
          sessionInfo = null;
          return null;
        }
        var email = String(d.email).toLowerCase();
        sessionInfo = {
          guest: email.slice(-GUEST_EMAIL_SUFFIX.length) === GUEST_EMAIL_SUFFIX,
          email: d.email,
          name: d.name || '',
        };
        // Compte réel connecté → plus aucun vestige invité.
        if (!sessionInfo.guest) clearStash();
        return sessionInfo;
      })
      .catch(function () {
        sessionInfo = null;
        return null;
      });
  }

  function resolveSession() {
    // Le handshake invité (index.html <head>) pose le token de manière
    // ASYNCHRONE — si le bridge charge avant sa fin, il faut l'attendre
    // avant de conclure « pas de session » (sinon les boutons n'apparaissent
    // jamais pour un nouveau visiteur).
    if (window.__nelthGuestReady && typeof window.__nelthGuestReady.then === 'function') {
      return window.__nelthGuestReady.then(
        function () {
          return resolveSessionNow();
        },
        function () {
          return resolveSessionNow();
        }
      );
    }
    return resolveSessionNow();
  }

  // ---------------------------------------------------------------------
  // 2) Boutons « Se connecter / S'inscrire » (haut droit, style ChatGPT)
  // ---------------------------------------------------------------------

  function ensureStyles() {
    if (document.getElementById('nelth-guest-actions-style')) return;
    var style = document.createElement('style');
    style.id = 'nelth-guest-actions-style';
    style.textContent = [
      '#nelth-guest-actions{display:flex;align-items:center;gap:8px;flex:none;}',
      '.nelth-guest-btn{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 14px;border-radius:9999px;font-size:13.5px;font-weight:500;line-height:1;cursor:pointer;user-select:none;white-space:nowrap;font-family:inherit;transition:background-color .15s ease,border-color .15s ease,opacity .15s ease;}',
      '.nelth-guest-btn:focus-visible{outline:2px solid rgba(99,102,241,0);box-shadow:0 0 0 2px currentColor;opacity:.85;}',
      '.nelth-guest-btn--login{border:1px solid rgba(0,0,0,.14);color:#374151;background:transparent;}',
      '.nelth-guest-btn--login:hover{background:rgba(0,0,0,.05);border-color:rgba(0,0,0,.2);}',
      'html.dark .nelth-guest-btn--login{border-color:rgba(255,255,255,.18);color:#e5e7eb;}',
      'html.dark .nelth-guest-btn--login:hover{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.28);}',
      '.nelth-guest-btn--signup{border:1px solid transparent;background:#111827;color:#ffffff;}',
      '.nelth-guest-btn--signup:hover{background:#1f2937;}',
      'html.dark .nelth-guest-btn--signup{background:#f9fafb;color:#111827;}',
      'html.dark .nelth-guest-btn--signup:hover{background:#e5e7eb;}',
      '.nelth-guest-btn[disabled]{opacity:.6;pointer-events:none;}',
      '@media (max-width:640px){',
      '#nelth-guest-actions{gap:6px;}',
      '.nelth-guest-btn{height:28px;padding:0 11px;font-size:12.5px;}',
      '.nelth-guest-btn--signup{display:none;}',
      '}',
    ].join('');
    document.head.appendChild(style);
  }

  /** Le cluster droit de la barre du SPA (autour de #temporary-chat-button). */
  function findRightCluster() {
    var btn = document.getElementById('temporary-chat-button');
    if (btn) {
      var el = btn.parentElement;
      while (el && el.tagName !== 'NAV' && el !== document.body) {
        var cls = typeof el.className === 'string' ? el.className : '';
        if (cls.indexOf('gap-3') !== -1 && cls.indexOf('flex-none') !== -1) return el;
        el = el.parentElement;
      }
    }
    return null;
  }

  function goAuth(form) {
    try {
      var token = localStorage.getItem('token');
      if (token) sessionStorage.setItem(STASH_KEY, token);
      localStorage.removeItem('token');
    } catch (e) {
      /* private mode → simple navigation */
    }
    window.location.href = '/auth' + (form ? '?form=' + form : '');
  }

  function buildActions() {
    var wrap = document.createElement('div');
    wrap.id = 'nelth-guest-actions';

    var login = document.createElement('button');
    login.type = 'button';
    login.className = 'nelth-guest-btn nelth-guest-btn--login';
    login.textContent = 'Se connecter';
    login.setAttribute('aria-label', 'Se connecter à un compte Nelth-IA');
    login.addEventListener('click', function () {
      login.disabled = true;
      goAuth('signin');
    });

    var signup = document.createElement('button');
    signup.type = 'button';
    signup.className = 'nelth-guest-btn nelth-guest-btn--signup';
    signup.textContent = "S'inscrire";
    signup.setAttribute('aria-label', 'Créer un compte Nelth-IA');
    signup.addEventListener('click', function () {
      signup.disabled = true;
      goAuth('signup');
    });

    wrap.appendChild(login);
    wrap.appendChild(signup);
    return wrap;
  }

  function injectActions() {
    if (!sessionInfo || !sessionInfo.guest) return;
    if (isAuthPage()) return;
    if (document.getElementById('nelth-guest-actions')) return;
    var cluster = findRightCluster();
    if (!cluster) return;
    ensureStyles();
    cluster.insertBefore(buildActions(), cluster.firstChild);
  }

  // Réinjection après chaque re-render/route du SPA (le cluster est recréé).
  function startObserving() {
    if (!('MutationObserver' in window) || !document.body) return;
    var scheduled = false;
    var observer = new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      setTimeout(function () {
        scheduled = false;
        injectActions();
        preselectSignupForm();
      }, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------
  // 3) Hygiène : déconnexion / connexion réussie → stash vidé
  // ---------------------------------------------------------------------

  function startSessionWatch() {
    var ticks = 0;
    var timer = setInterval(function () {
      ticks += 1;
      if (ticks > 600) {
        // ~12 minutes : la page a sûrement changé entre-temps.
        clearInterval(timer);
        return;
      }
      var token = getToken();

      // Déconnexion (token disparu) → l'invité actuel ne doit PAS être
      // restauré : prochain passage sur / = invité NEUF (comme ChatGPT).
      if (lastSeenToken && !token) {
        clearStash();
        lastSeenToken = token;
        return;
      }

      // Connexion réussie sur /auth (token réapparu) → plus de stash.
      if (token && token !== lastSeenToken && isAuthPage()) {
        var st = null;
        try {
          st = sessionStorage.getItem(STASH_KEY);
        } catch (e) {
          /* private mode */
        }
        if (!st || st !== token) {
          clearStash();
          lastSeenToken = token;
        }
      }
      lastSeenToken = token;
    }, 1200);
  }

  // ---------------------------------------------------------------------
  // 4) /auth?form=signup → présélection de l'onglet « S'inscrire »
  // ---------------------------------------------------------------------

  // Le build compilé d'Open WebUI n'exploite pas ?form= pour choisir l'onglet
  // (le paramètre ne sert qu'aux gardes oauth/redirect). Le bouton « S'inscrire »
  // du mode invité pointe vers /auth?form=signup : ce bridge clique le toggle
  // signin↔signup une fois le formulaire rendu — détection du mode SANS dépendre
  // de la locale (comptage d'inputs : signin = email+password, signup =
  // nom+email+password).

  var signupPreselected = false;

  function authFormMode() {
    var inputs = document.querySelectorAll('input');
    var pwd = 0;
    var text = 0;
    for (var i = 0; i < inputs.length; i++) {
      var type = (inputs[i].type || '').toLowerCase();
      if (type === 'password') pwd += 1;
      else if (type === 'text' || type === 'email') text += 1;
    }
    if (pwd >= 1 && text >= 2) return 'signup';
    if (pwd >= 1) return 'signin';
    return null; // formulaire pas encore rendu
  }

  function preselectSignupForm() {
    if (signupPreselected || !isAuthPage()) return;
    var params = new URLSearchParams(window.location.search);
    if (params.get('form') !== 'signup') {
      signupPreselected = true; // pas concerné → une seule vérification
      return;
    }
    var mode = authFormMode();
    if (mode === 'signup') {
      signupPreselected = true; // déjà sur le bon onglet
      return;
    }
    if (mode !== 'signin') return; // attendre le rendu (retry via observer)
    // Le toggle signin↔signup : bouton souligné (signature du build, sans
    // dépendance i18n du texte « Sign up »).
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var cls = typeof btns[i].className === 'string' ? btns[i].className : '';
      if (cls.indexOf('underline') !== -1 && cls.indexOf('font-normal') !== -1) {
        signupPreselected = true;
        btns[i].click();
        return;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Boot du bridge
  // ---------------------------------------------------------------------

  function boot() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        injectActions();
        preselectSignupForm();
        startObserving();
      });
    } else {
      injectActions();
      preselectSignupForm();
      startObserving();
    }
    startSessionWatch();
  }

  resolveSession().then(function () {
    boot();
  });
})();
