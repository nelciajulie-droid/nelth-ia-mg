/**
 * Nelth-AI — Mode Invité (guest bridge), affichage à la ChatGPT.
 *
 * Ce script (chargé sur TOUTES les pages du SPA) fait 8 choses :
 *
 *   1. Résout la session courante via /api/v1/auths/ et détecte si c'est un
 *      compte invité (email *@guests.nelth-ia.local — compte anonyme jetable
 *      provisionné par POST /api/v1/auths/guest, voir le handshake dans
 *      index.html <head>). L'invité est ANONYME : aucune identification, ses
 *      discussions ne sont PAS enregistrées (invisible dans la sidebar,
 *      purgé par scripts/cleanup-guests.ts).
 *
 *   2. Sidebar — À LA CHATGPT logged-out : la liste de conversations est
 *      REMPLACÉE par une carte « Se connecter / S'inscrire » (« pour
 *      enregistrer vos discussions ») ; le badge de compte en bas de la
 *      sidebar (avatar « Invité ») est retiré (tiroir OUVERT et rail
 *      replié — aucune trace de compte pour l'invité). L'invité n'est
 *      JAMAIS présenté comme un compte.
 *
 *   3. Barre du haut — boutons « Se connecter » + « S'inscrire » injectés en
 *      haut à droite (affichage ChatGPT), VISIBLES sur la vue principale
 *      uniquement : dès qu'une discussion est ouverte (route /c/…) ils
 *      deviennent invisibles, et reviennent sur « / ».
 *
 *   4. Imagine (bouton Images du rail + du tiroir) : le bouton reste AFFICHÉ
 *      pour l'invité, mais le clic n'ouvre PAS le studio — il affiche
 *      l'invite « Se connecter / S'inscrire ». Le studio Images est réservé
 *      aux comptes (génération d'images/vidéos).
 *
 *   5. Sélecteur de modèle : totalement retiré pour l'invité (le serveur
 *      épingle de toute façon les complétions invitées au modèle par défaut
 *      — v12-flow.ts + models-registry.ts).
 *
 *   6. Page /auth — bouton « × » (haut droit de la carte) pour revenir à la
 *      page précédente (fallback « / » quand il n'y a pas d'historique).
 *
 *   7. Fonctionnalités verrouillées (parité ChatGPT logged-out, appliquée
 *      CÔTÉ SERVEUR — v12-flow.ts / models-registry.ts / root-handlers.ts /
 *      files.ts / images.ts / retrieval.ts) — ce bridge ne fait que
 *      refléter l'état dans l'UI : images & vidéos, recherche web,
 *      téléversement, l'espace de travail masqué, le paperclip neutralisé.
 *
 *   8. Hygiène de session : déconnexion détectée → stash vidé (le prochain
 *      passage sur / recrée un invité NEUF, comme ChatGPT) ; connexion
 *      réelle réussie → stash vidé + classe nelth-guest retirée ; JWT invité
 *      expiré (401) → rotation silencieuse vers un nouvel invité (une seule
 *      tentative par chargement).
 *
 *   AUCUN compteur : le mode invité n'est PAS un budget — c'est une session
 * jetable sans historique (les discussions ne survivent ni enregistrées,
 * ni partagées).
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

  /** Vue principale = nouveau chat (route « / ») — PAS une discussion. */
  function isMainView() {
    return window.location.pathname === '/';
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

  // ---------------------------------------------------------------------
  // 1) Résolution de session
  // ---------------------------------------------------------------------

  function applyGuestClass() {
    var root = document.documentElement;
    if (sessionInfo && sessionInfo.guest) root.classList.add('nelth-guest');
    else root.classList.remove('nelth-guest');
  }

  function resolveSessionNow() {
    var token = getToken();
    lastSeenToken = token;
    if (!token) {
      sessionInfo = null;
      applyGuestClass();
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
          applyGuestClass();
          return null;
        }
        var email = String(d.email).toLowerCase();
        sessionInfo = {
          guest: email.slice(-GUEST_EMAIL_SUFFIX.length) === GUEST_EMAIL_SUFFIX,
          email: d.email,
          name: d.name || '',
        };
        applyGuestClass();
        // Compte réel connecté → plus aucun vestige invité.
        if (!sessionInfo.guest) clearStash();
        return sessionInfo;
      })
      .catch(function () {
        sessionInfo = null;
        applyGuestClass();
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
  // 2) Styles (boutons + carte sidebar + invite Imagine + × auth)
  // ---------------------------------------------------------------------

  function ensureStyles() {
    if (document.getElementById('nelth-guest-actions-style')) return;
    var style = document.createElement('style');
    style.id = 'nelth-guest-actions-style';
    style.textContent = [
      // ---- Boutons « Se connecter / S'inscrire » (barre du haut) ----
      '#nelth-guest-actions{display:flex;align-items:center;gap:8px;flex:none;}',
      '#nelth-guest-actions.nelth-guest-actions--hidden{display:none !important;}',
      '.nelth-guest-btn{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 14px;border-radius:9999px;font-size:13.5px;font-weight:500;line-height:1;cursor:pointer;user-select:none;white-space:nowrap;font-family:inherit;transition:background-color .15s ease,border-color .15s ease,opacity .15s ease;}',
      '.nelth-guest-btn:focus-visible{outline:2px solid rgba(0,0,0,.25);opacity:.85;}',
      '.nelth-guest-btn--login{border:1px solid rgba(0,0,0,.14);color:#374151;background:transparent;}',
      '.nelth-guest-btn--login:hover{background:rgba(0,0,0,.05);border-color:rgba(0,0,0,.2);}',
      'html.dark .nelth-guest-btn--login{border-color:rgba(255,255,255,.18);color:#e5e7eb;}',
      'html.dark .nelth-guest-btn--login:hover{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.28);}',
      '.nelth-guest-btn--signup{border:1px solid transparent;background:#111827;color:#ffffff;}',
      '.nelth-guest-btn--signup:hover{background:#1f2937;}',
      'html.dark .nelth-guest-btn--signup{background:#f9fafb;color:#111827;}',
      'html.dark .nelth-guest-btn--signup:hover{background:#e5e7eb;}',
      '.nelth-guest-btn[disabled]{opacity:.6;pointer-events:none;}',

      // ---- Mode invité : l'invité n'est PAS un compte ----
      // Liste de conversations masquée + badge de compte retiré (les deux
      // variantes de sidebar : tiroir étendu + rail replié 42 px). Sélecteurs
      // STRUCTURELS + les deux locales (EN « User menu » / FR « Menu
      // utilisateur ») — l'avatar invité ne doit jamais s'afficher en bas.
      'html.nelth-guest #sidebar .overflow-y-auto > .relative{display:none !important;}',
      'html.nelth-guest #sidebar .sticky.bottom-0{display:none !important;}',
      'html.nelth-guest #sidebar button[aria-label="User menu"]{display:none !important;}',
      'html.nelth-guest #sidebar button[aria-label="Menu utilisateur"]{display:none !important;}',
      // ATTENTION : ne JAMAIS cibler `#sidebar > div:last-child` — quand le
      // tiroir est OUVERT, ce dernier enfant est le tiroir ENTIER (cette règle
      // vidait la sidebar ouverte). Le rail replié n'a pas d'avatar : les
      // sélecteurs « User menu » ci-dessus couvrent les deux locales.
      // Sélecteur de modèle : TOTALEMENT retiré pour l'invité.
      'html.nelth-guest #model-selector-model-button{display:none !important;}',
      'html.nelth-guest button[aria-label^="Selected model"]{display:none !important;}',
      // Espace de travail masqué + paperclip neutralisés (verrous serveur
      // réels : files.ts / retrieval.ts / images.ts 403).
      'html.nelth-guest a[href*="/workspace"]{display:none !important;}',
      'html.nelth-guest button[aria-label="Attach files"],',
      'html.nelth-guest button[aria-label="Joindre des fichiers"],',
      'html.nelth-guest button[aria-label="Pièces jointes"]{display:none !important;}',
      '.nelth-guest-hidden{display:none !important;}',

      // ---- Carte « Se connecter ou S'inscrire » (sidebar — tiroir) ----
      '#nelth-guest-cta{padding:14px 12px 18px;}',
      '.ngcta-card{display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:14px;border:1px solid rgba(0,0,0,.07);background:rgba(0,0,0,.025);}',
      'html.dark .ngcta-card{border-color:rgba(255,255,255,.09);background:rgba(255,255,255,.04);}',
      '.ngcta-icon{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:10px;background:#111827;color:#fff;flex:none;}',
      'html.dark .ngcta-icon{background:#f9fafb;color:#111827;}',
      '.ngcta-icon svg{width:15px;height:15px;}',
      '.ngcta-title{margin:0;font-size:13.5px;font-weight:600;color:#111827;}',
      'html.dark .ngcta-title{color:#f3f4f6;}',
      '.ngcta-text{margin:0;font-size:12px;line-height:1.45;color:#6b7280;}',
      'html.dark .ngcta-text{color:#9ca3af;}',
      '.ngcta-actions{display:flex;gap:8px;flex-wrap:wrap;}',

      // ---- Invite « Se connecter / S'inscrire » (clic Imagine, etc.) ----
      '#nelth-auth-prompt-backdrop{position:fixed;inset:0;z-index:119;background:rgba(0,0,0,.32);}',
      '#nelth-auth-prompt{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:120;display:flex;align-items:flex-start;gap:12px;max-width:min(420px,calc(100vw - 32px));padding:18px 20px;border-radius:16px;background:#ffffff;border:1px solid rgba(0,0,0,.08);box-shadow:0 16px 48px rgba(0,0,0,.18);font-family:inherit;}',
      'html.dark #nelth-auth-prompt{background:#1f2226;border-color:rgba(255,255,255,.1);box-shadow:0 16px 48px rgba(0,0,0,.5);}',
      '.ngap-icon{display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;background:#111827;color:#fff;flex:none;margin-top:2px;}',
      'html.dark .ngap-icon{background:#f9fafb;color:#111827;}',
      '.ngap-icon svg{width:16px;height:16px;}',
      '.ngap-body{flex:1;min-width:0;}',
      '.ngap-title{margin:0 0 4px;font-size:14.5px;font-weight:600;color:#111827;}',
      'html.dark .ngap-title{color:#f3f4f6;}',
      '.ngap-text{margin:0 0 12px;font-size:13px;line-height:1.5;color:#6b7280;}',
      'html.dark .ngap-text{color:#9ca3af;}',
      '.ngap-actions{display:flex;gap:8px;flex-wrap:wrap;}',
      '.ngap-btn{display:inline-flex;align-items:center;justify-content:center;height:34px;padding:0 16px;border-radius:9999px;font-size:13px;font-weight:500;line-height:1;cursor:pointer;user-select:none;white-space:nowrap;font-family:inherit;}',
      '.ngap-btn--signup{border:1px solid transparent;background:#111827;color:#fff;}',
      '.ngap-btn--signup:hover{background:#1f2937;}',
      'html.dark .ngap-btn--signup{background:#f9fafb;color:#111827;}',
      'html.dark .ngap-btn--signup:hover{background:#e5e7eb;}',
      '.ngap-btn--login{border:1px solid rgba(0,0,0,.14);color:#374151;background:transparent;}',
      '.ngap-btn--login:hover{background:rgba(0,0,0,.05);}',
      'html.dark .ngap-btn--login{border-color:rgba(255,255,255,.18);color:#e5e7eb;}',
      'html.dark .ngap-btn--login:hover{background:rgba(255,255,255,.08);}',
      '.ngap-close{flex:none;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;border:none;background:transparent;color:#9ca3af;cursor:pointer;font-size:16px;line-height:1;}',
      '.ngap-close:hover{background:rgba(0,0,0,.06);color:#374151;}',
      'html.dark .ngap-close:hover{background:rgba(255,255,255,.08);color:#d1d5db;}',

      // ---- Bouton « × » sur la page /auth ----
      '#nelth-auth-x{position:absolute;top:10px;right:10px;z-index:30;display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:9999px;border:1px solid rgba(0,0,0,.12);background:#fff;color:#374151;cursor:pointer;font-size:15px;line-height:1;transition:background-color .15s ease,border-color .15s ease;}',
      '#nelth-auth-x:hover{background:rgba(0,0,0,.05);border-color:rgba(0,0,0,.2);}',
      'html.dark #nelth-auth-x{background:#1f2226;border-color:rgba(255,255,255,.16);color:#e5e7eb;}',
      'html.dark #nelth-auth-x:hover{background:rgba(255,255,255,.08);}',

      '@media (max-width:640px){',
      '#nelth-guest-actions{gap:6px;}',
      '.nelth-guest-btn{height:28px;padding:0 11px;font-size:12.5px;}',
      '.nelth-guest-btn--signup{display:none;}',
      '#nelth-guest-cta{padding:12px 8px 14px;}',
      '}',
    ].join('\n');
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------
  // 3) Boutons « Se connecter / S'inscrire » (haut droit) — vue principale
  //    seulement : invisibles dès qu'une discussion est ouverte.
  // ---------------------------------------------------------------------

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
    signup.textContent = 'S\u2019inscrire';
    signup.setAttribute('aria-label', 'Créer un compte Nelth-IA');
    signup.addEventListener('click', function () {
      signup.disabled = true;
      goAuth('signup');
    });

    wrap.appendChild(login);
    wrap.appendChild(signup);
    return wrap;
  }

  /** Vue principale → boutons visibles ; discussion (route /c/…) → invisibles. */
  function applyRouteVisibility() {
    var wrap = document.getElementById('nelth-guest-actions');
    if (!wrap) return;
    wrap.classList.toggle('nelth-guest-actions--hidden', !isMainView());
  }

  function injectActions() {
    if (!sessionInfo || !sessionInfo.guest) return;
    if (isAuthPage()) return;
    if (document.getElementById('nelth-guest-actions')) {
      applyRouteVisibility();
      return;
    }
    var cluster = findRightCluster();
    if (!cluster) return;
    ensureStyles();
    cluster.insertBefore(buildActions(), cluster.firstChild);
    applyRouteVisibility();
  }

  // ---------------------------------------------------------------------
  // 4) Sidebar — carte « Se connecter / S'inscrire » à la place de la
  //    liste de conversations + bouton compact sur le rail replié.
  // ---------------------------------------------------------------------

  var ICON_LOGIN =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>';

  function ctaButton(variant, label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className =
      variant === 'signup' ? 'nelth-guest-btn nelth-guest-btn--signup' : 'nelth-guest-btn nelth-guest-btn--login';
    b.textContent = label;
    b.addEventListener('click', function () {
      goAuth(variant === 'signup' ? 'signup' : 'signin');
    });
    return b;
  }

  /** Carte tiroir (sidebar étendue) : à la place de la liste de conversations. */
  function buildCtaCard() {
    var host = document.createElement('div');
    host.id = 'nelth-guest-cta';

    var card = document.createElement('div');
    card.className = 'ngcta-card';

    var icon = document.createElement('div');
    icon.className = 'ngcta-icon';
    icon.innerHTML = ICON_LOGIN;

    var title = document.createElement('p');
    title.className = 'ngcta-title';
    title.textContent = 'Enregistrer vos discussions';

    var text = document.createElement('p');
    text.className = 'ngcta-text';
    text.textContent =
      'Créez un compte ou connectez-vous pour enregistrer vos discussions et les retrouver sur tous vos appareils.';

    var actions = document.createElement('div');
    actions.className = 'ngcta-actions';
    actions.appendChild(ctaButton('signup', 'S\u2019inscrire'));
    actions.appendChild(ctaButton('login', 'Se connecter'));

    card.appendChild(icon);
    card.appendChild(title);
    card.appendChild(text);
    card.appendChild(actions);
    host.appendChild(card);
    return host;
  }

  // Le bouton compact « Compte » du rail REPLIÉ est SUPPRIMÉ (correction
  // utilisateur) : rien sous Imagine sur le rail fermé, et l'avatar du bas
  // est masqué par la règle CSS `html.nelth-guest #sidebar > div:last-child`.
  // Le tiroir OUVERT garde sa carte « Se connecter / S'inscrire ».

  /**
   * Ré-injection après chaque re-render du SPA. Cible : le tiroir étendu —
   * la zone défilante qui porte Folders/Chats (l'invité n'a PAS de liste :
   * la CSS la masque, la carte la remplace). Le rail REPLIÉ n'est PAS
   * modifié (aucun bouton « Compte », avatar du bas masqué par CSS).
   */
  function syncSidebar() {
    if (!sessionInfo || !sessionInfo.guest) return;

    // Tiroir (sidebar étendue) — la carte vit dans la zone défilante.
    var scroll = document.querySelector('#sidebar .overflow-y-auto');
    if (scroll && !scroll.querySelector('#nelth-guest-cta')) {
      ensureStyles();
      scroll.appendChild(buildCtaCard());
    }
  }

  // ---------------------------------------------------------------------
  // 5) Imagine — le bouton reste affiché, le clic ouvre l'invite de
  //    connexion (studio réservé aux comptes). Intercepté en PHASE DE
  //    CAPTURE au niveau document : avant les handlers du pont Images.
  // ---------------------------------------------------------------------

  function hideAuthPrompt() {
    var backdrop = document.getElementById('nelth-auth-prompt-backdrop');
    var prompt = document.getElementById('nelth-auth-prompt');
    if (backdrop) backdrop.remove();
    if (prompt) prompt.remove();
  }

  function showAuthPrompt(opts) {
    if (!sessionInfo || !sessionInfo.guest) return;
    if (isAuthPage()) return;
    hideAuthPrompt();
    ensureStyles();

    var backdrop = document.createElement('div');
    backdrop.id = 'nelth-auth-prompt-backdrop';

    var wrap = document.createElement('div');
    wrap.id = 'nelth-auth-prompt';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'false');
    wrap.setAttribute('aria-label', (opts && opts.title) || 'Connexion requise');

    var icon = document.createElement('div');
    icon.className = 'ngap-icon';
    icon.innerHTML = ICON_LOGIN;

    var body = document.createElement('div');
    body.className = 'ngap-body';

    var title = document.createElement('p');
    title.className = 'ngap-title';
    title.textContent = (opts && opts.title) || 'Connexion requise';

    var text = document.createElement('p');
    text.className = 'ngap-text';
    text.textContent =
      (opts && opts.text) ||
      'Créez un compte gratuit ou connectez-vous pour enregistrer vos discussions et débloquer toutes les fonctionnalités.';

    var actions = document.createElement('div');
    actions.className = 'ngap-actions';

    var signup = document.createElement('button');
    signup.type = 'button';
    signup.className = 'ngap-btn ngap-btn--signup';
    signup.textContent = 'S\u2019inscrire';
    signup.addEventListener('click', function () {
      goAuth('signup');
    });

    var login = document.createElement('button');
    login.type = 'button';
    login.className = 'ngap-btn ngap-btn--login';
    login.textContent = 'Se connecter';
    login.addEventListener('click', function () {
      goAuth('signin');
    });

    actions.appendChild(signup);
    actions.appendChild(login);
    body.appendChild(title);
    body.appendChild(text);
    body.appendChild(actions);

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'ngap-close';
    close.setAttribute('aria-label', 'Fermer');
    close.textContent = '×';
    close.addEventListener('click', hideAuthPrompt);

    wrap.appendChild(icon);
    wrap.appendChild(body);
    wrap.appendChild(close);

    backdrop.addEventListener('click', hideAuthPrompt);
    document.body.appendChild(backdrop);
    document.body.appendChild(wrap);
  }

  /** Sélecteurs du bouton Imagine (rail + tiroir + liens #/images). */
  var IMAGINE_HASH_RE = /^#\/images\/?$/;

  function isImagineTarget(el) {
    if (!el || !el.closest) return false;
    return !!el.closest(
      '#images-rail, #images-nav, a[href="#/images"], [aria-label="Images"], [aria-label="Imagine"]'
    );
  }

  function guardImagineClicks() {
    document.addEventListener(
      'click',
      function (e) {
        if (!sessionInfo || !sessionInfo.guest) return;
        if (!isImagineTarget(e.target)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        showAuthPrompt({
          title: 'Imagine est réservé aux comptes',
          text: 'La génération d\u2019images et de vidéos est réservée aux comptes. Créez un compte gratuit ou connectez-vous pour y accéder.',
        });
      },
      true
    );
  }

  // Deep-link résiduel (#/images posé avant la résolution de session) :
  // un invité qui atterrit directement sur le hash Images ne doit pas
  // ouvrir le studio — le hash est retiré avant le premier sync du pont.
  function stripImagineHash() {
    try {
      if (IMAGINE_HASH_RE.test(window.location.hash || '')) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    } catch (e) {
      /* private mode */
    }
  }

  // ---------------------------------------------------------------------
  // 6) Page /auth — bouton « × » pour revenir à la page précédente
  // ---------------------------------------------------------------------

  function authCloseClick() {
    if (window.history.length > 1) window.history.back();
    else window.location.href = '/';
  }

  function syncAuthClose() {
    if (!isAuthPage()) return;
    var form = document.querySelector('form');
    if (!form) return;
    var host = form.parentElement;
    if (!host || host.querySelector('#nelth-auth-x')) return;
    // La carte du formulaire : position:relative pour ancrer le « × ».
    var position = window.getComputedStyle(host).position;
    if (position !== 'relative' && position !== 'absolute') host.style.position = 'relative';
    ensureStyles();

    var x = document.createElement('button');
    x.type = 'button';
    x.id = 'nelth-auth-x';
    x.textContent = '×';
    x.setAttribute('aria-label', 'Retour à la page précédente');
    x.title = 'Retour';
    x.addEventListener('click', authCloseClick);
    host.appendChild(x);
  }

  // ---------------------------------------------------------------------
  // 7) Verrous UI invité (les refus RÉELS sont côté serveur — files.ts,
  //    retrieval.ts, images.ts 403 : ici on masque les contrôles pour éviter
  //    les culs-de-sac). Le SPA re-rend en permanence → ré-appliqué par le
  //    MutationObserver (les items du menu « + » n'existent que popover ouvert).
  // ---------------------------------------------------------------------

  /** Libellés d'attachement (menu « + »), préfixes EN + FR. */
  var GUEST_LOCK_PREFIX_RE =
    /^(upload|télévers|import|attach|joindre|attacher|capture|screenshot|caméra|camera|webpage|page web)/i;
  /** Boutons du composeur verrouillés pour les invités (intégrations — les
   *  comptes). VOIX NON VERROUILLÉE (correction utilisateur) : le mode vocal
   *  et la dictée restent disponibles aux invités. */
  var GUEST_LOCK_EXACT = [
    'integrations',
    'intégrations',
  ];

  function labelOf(el) {
    return (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '')) || '';
  }

  function lockGuestControls() {
    if (!sessionInfo || !sessionInfo.guest) return;

    // 1) Neutraliser TOUT input fichier du composeur (le clic paperclip ne
    // peut plus ouvrir de boîte de dialogue — verrou fonctionnel).
    var inputs = document.querySelectorAll('input[type=file]');
    for (var i = 0; i < inputs.length; i++) {
      if (!inputs[i].disabled) {
        inputs[i].disabled = true;
        inputs[i].setAttribute('data-nelth-guest-locked', '1');
      }
    }

    // 2) Masquer les items d'attachement du menu « + » (Upload Files,
    // Attach Files, Attach Webpage, Attach Knowledge, Capture…) — ils
    // n'existent que popover ouvert, d'où le re-passage de l'observateur.
    var items = document.querySelectorAll('[role="menuitem"]');
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var txt = (labelOf(it) || it.textContent || '').trim().toLowerCase();
      if (txt && GUEST_LOCK_PREFIX_RE.test(txt)) it.classList.add('nelth-guest-hidden');
    }

    // 3) Masquer les boutons du composeur voix / intégrations (comptes).
    var buttons = document.querySelectorAll('button[aria-label]');
    for (var k = 0; k < buttons.length; k++) {
      var b = buttons[k];
      var bl = labelOf(b).trim().toLowerCase();
      if (bl && GUEST_LOCK_EXACT.indexOf(bl) !== -1) b.classList.add('nelth-guest-hidden');
    }
  }

  // ---------------------------------------------------------------------
  // 8) Navigation SPA — route changes (pushState/replaceState/popstate)
  // ---------------------------------------------------------------------

  function hookHistory() {
    ['pushState', 'replaceState'].forEach(function (name) {
      var orig = window.history[name];
      if (typeof orig !== 'function') return;
      window.history[name] = function () {
        var result = orig.apply(this, arguments);
        onRouteChange();
        return result;
      };
    });
    window.addEventListener('popstate', onRouteChange);
    window.addEventListener('hashchange', onRouteChange);
  }

  function onRouteChange() {
    applyRouteVisibility();
    syncSidebar();
    syncAuthClose();
  }

  // Ré-injection après chaque re-render/route du SPA (le cluster est recréé).
  function startObserving() {
    if (!('MutationObserver' in window) || !document.body) return;
    var scheduled = false;
    var observer = new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      setTimeout(function () {
        scheduled = false;
        injectActions();
        syncSidebar();
        syncAuthClose();
        preselectSignupForm();
        lockGuestControls();
      }, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------
  // 9) Hygiène : déconnexion / connexion réussie → stash vidé
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
  // 10) /auth?form=signup → présélection de l'onglet « S'inscrire »
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
    stripImagineHash();
    guardImagineClicks();
    hookHistory();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        injectActions();
        syncSidebar();
        syncAuthClose();
        preselectSignupForm();
        startObserving();
      });
    } else {
      injectActions();
      syncSidebar();
      syncAuthClose();
      preselectSignupForm();
      startObserving();
    }
    startSessionWatch();
    if (sessionInfo && sessionInfo.guest) {
      lockGuestControls();
    }
  }

  resolveSession().then(function () {
    boot();
  });
})();
