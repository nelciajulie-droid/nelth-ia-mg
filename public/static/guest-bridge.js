/**
 * Nelth-AI — Mode Invité (guest bridge), affichage à la ChatGPT.
 *
 * Rôle de ce script (chargé sur TOUTES les pages du SPA) :
 *
 *   1. Résout la session courante via /api/v1/auths/ et détecte si c'est un
 *      compte invité (email *@guests.nelth-ia.local — compte anonyme jetable
 *      provisionné par POST /api/v1/auths/guest, voir le handshake dans
 *      index.html <head>). L'invité est ANONYME : aucune identification, les
 *      conversations ne survivent pas au navigateur, le compte est purgé par
 *      scripts/cleanup-guests.ts.
 *
 *   2. Si (et seulement si) la session est INVITÉE et qu'on n'est PAS sur la
 *      page /auth : injecte « Se connecter » + « S'inscrire » en haut à
 *      droite de la barre du SPA — exactement l'affichage ChatGPT — PRÉCÉDÉS
 *      d'une pastille « Invité · N messages restants » (compteur servi par
 *      GET /api/v1/auths/guest/usage, incrémenté par le pipeline chat).
 *      La page de login/signup reste INTACTE (aucun bouton invité dessus).
 *
 *   3. MODE INVITÉ = fonctionnalités verrouillées (parité ChatGPT logged-out,
 *      appliquée CÔTÉ SERVEUR — v12-flow.ts / models-registry.ts / config —
 *      ce bridge ne fait que refléter l'état dans l'UI) :
 *      • sélecteur de modèle → modèle par défaut unique (Nelth-3.5) ;
 *      • génération d'images & de vidéos → verrouillées ;
 *      • recherche web → verrouillée ;
 *      • téléversement de fichiers → verrouillé (paperclip neutralisé) ;
 *      • studio Images → masqué (#images-rail / #images-nav via la classe
 *        html.nelth-guest) ;
 *      • budget de messages (défaut 10) → bannière « Créez un compte » à
 *        l'épuisement, + message d'erreur dans le chat côté serveur.
 *
 *   4. Clic sur Se connecter / S'inscrire : le token invité est mis de côté
 *      (sessionStorage) puis retiré → /auth?form=signin|signup s'ouvre
 *      proprement. Si l'utilisateur revient SANS se connecter, le handshake
 *      (index.html) RESTAURE la session invitée et ses conversations au lieu
 *      d'en recréer une neuve.
 *
 *   5. Hygiène de session : déconnexion détectée → stash vidé (le prochain
 *      passage sur / recrée un invité NEUF, comme ChatGPT) ; connexion réelle
 *      réussie → stash vidé + classe nelth-guest retirée ; JWT invité expiré
 *      (401) → rotation silencieuse vers un nouvel invité (une seule tentative
 *      par chargement).
 */
(() => {
  if (window.__nelthGuestBridge) return;
  window.__nelthGuestBridge = true;

  var GUEST_EMAIL_SUFFIX = '@guests.nelth-ia.local';
  var STASH_KEY = 'nelth-guest-stash';
  var ROTATE_FLAG = 'nelth-guest-rotated';

  var sessionInfo = null; // { guest, email, name } | null
  var lastSeenToken = null;
  var usageInfo = null; // { guest, used, limit, remaining } | null
  var usageFetchScheduled = false;

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
  // 2) Compteur invité — GET /api/v1/auths/guest/usage
  // ---------------------------------------------------------------------

  function usageText(d) {
    if (!d) return 'Mode invité';
    if (d.remaining === 0) return 'Invité · limite atteinte';
    if (d.remaining === 1) return 'Invité · dernier message';
    return 'Invité · ' + d.remaining + ' messages restants';
  }

  function updateUsagePill() {
    var pill = document.getElementById('nelth-guest-usage');
    if (!pill) return;
    pill.textContent = usageText(usageInfo);
    if (usageInfo && usageInfo.remaining === 0) pill.classList.add('nelth-guest-usage--over');
    else if (usageInfo && usageInfo.remaining <= 2) pill.classList.add('nelth-guest-usage--low');
    else pill.classList.remove('nelth-guest-usage--over', 'nelth-guest-usage--low');
  }

  function fetchUsage() {
    if (!sessionInfo || !sessionInfo.guest || isAuthPage()) return Promise.resolve(null);
    var token = getToken();
    if (!token) return Promise.resolve(null);
    return fetch('/api/v1/auths/guest/usage', {
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
    })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (d) {
        if (!d || !d.guest) {
          usageInfo = null;
          return null;
        }
        usageInfo = d;
        updateUsagePill();
        if (d.remaining === 0) showLimitBanner();
        return d;
      })
      .catch(function () {
        return null;
      });
  }

  /** Anti-tempête : le MutationObserver du SPA déclenche en rafale. */
  function scheduleUsageFetch() {
    if (usageFetchScheduled) return;
    usageFetchScheduled = true;
    setTimeout(function () {
      usageFetchScheduled = false;
      fetchUsage();
    }, 2500);
  }

  function startUsagePolling() {
    fetchUsage();
    setInterval(fetchUsage, 20000);
  }

  // ---------------------------------------------------------------------
  // 3) Boutons « Se connecter / S'inscrire » + pastille (haut droit)
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
      // Pastille « Invité · N messages restants »
      '.nelth-guest-usage{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:9999px;font-size:12.5px;font-weight:500;line-height:1;white-space:nowrap;color:#6b7280;background:rgba(0,0,0,.04);border:1px solid rgba(0,0,0,.06);user-select:none;cursor:default;}',
      'html.dark .nelth-guest-usage{color:#9ca3af;background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.08);}',
      '.nelth-guest-usage--low{color:#b45309;background:rgba(245,158,11,.12);border-color:rgba(245,158,11,.25);}',
      'html.dark .nelth-guest-usage--low{color:#fbbf24;background:rgba(245,158,11,.15);border-color:rgba(245,158,11,.3);}',
      '.nelth-guest-usage--over{color:#b91c1c;background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.3);}',
      'html.dark .nelth-guest-usage--over{color:#f87171;background:rgba(239,68,68,.15);border-color:rgba(239,68,68,.35);}',
      // Verrous invité : studio Images + espace de travail masqués, paperclip neutralisé
      'html.nelth-guest #images-rail,html.nelth-guest #images-nav{display:none !important;}',
      'html.nelth-guest a[href*="/workspace"]{display:none !important;}',
      '.nelth-guest-hidden{display:none !important;}',
      'html.nelth-guest button[aria-label="Attach files"],',
      'html.nelth-guest button[aria-label="Joindre des fichiers"],',
      'html.nelth-guest button[aria-label="Pièces jointes"]{display:none !important;}',
      '@media (max-width:640px){',
      '#nelth-guest-actions{gap:6px;}',
      '.nelth-guest-btn{height:28px;padding:0 11px;font-size:12.5px;}',
      '.nelth-guest-btn--signup{display:none;}',
      '.nelth-guest-usage{height:28px;padding:0 10px;font-size:11.5px;}',
      '}',
    ].join('\n');
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

    var usage = document.createElement('span');
    usage.id = 'nelth-guest-usage';
    usage.className = 'nelth-guest-usage';
    usage.textContent = usageText(usageInfo);
    usage.title = 'Mode invité — créez un compte pour discuter sans limites et débloquer toutes les fonctionnalités.';
    wrap.appendChild(usage);

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
    updateUsagePill();
  }

  // ---------------------------------------------------------------------
  // 3bis) Bannière « limite atteinte » (mur d'inscription, à la ChatGPT)
  // ---------------------------------------------------------------------

  function ensureBannerStyles() {
    if (document.getElementById('nelth-guest-banner-style')) return;
    var style = document.createElement('style');
    style.id = 'nelth-guest-banner-style';
    style.textContent = [
      '#nelth-guest-limit-banner{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:80;display:flex;align-items:flex-start;gap:12px;max-width:min(440px,calc(100vw - 32px));padding:16px 18px;border-radius:16px;background:#ffffff;border:1px solid rgba(0,0,0,.08);box-shadow:0 12px 40px rgba(0,0,0,.14);font-family:inherit;}',
      'html.dark #nelth-guest-limit-banner{background:#1f2226;border-color:rgba(255,255,255,.1);box-shadow:0 12px 40px rgba(0,0,0,.5);}',
      '.nglb-body{flex:1;min-width:0;}',
      '.nglb-title{margin:0 0 4px;font-size:14.5px;font-weight:600;color:#111827;}',
      'html.dark .nglb-title{color:#f3f4f6;}',
      '.nglb-text{margin:0 0 12px;font-size:13px;line-height:1.5;color:#6b7280;}',
      'html.dark .nglb-text{color:#9ca3af;}',
      '.nglb-actions{display:flex;gap:8px;flex-wrap:wrap;}',
      '.nglb-btn{display:inline-flex;align-items:center;justify-content:center;height:34px;padding:0 16px;border-radius:9999px;font-size:13px;font-weight:500;line-height:1;cursor:pointer;user-select:none;white-space:nowrap;font-family:inherit;}',
      '.nglb-btn--signup{border:1px solid transparent;background:#111827;color:#fff;}',
      '.nglb-btn--signup:hover{background:#1f2937;}',
      'html.dark .nglb-btn--signup{background:#f9fafb;color:#111827;}',
      'html.dark .nglb-btn--signup:hover{background:#e5e7eb;}',
      '.nglb-btn--login{border:1px solid rgba(0,0,0,.14);color:#374151;background:transparent;}',
      '.nglb-btn--login:hover{background:rgba(0,0,0,.05);}',
      'html.dark .nglb-btn--login{border-color:rgba(255,255,255,.18);color:#e5e7eb;}',
      'html.dark .nglb-btn--login:hover{background:rgba(255,255,255,.08);}',
      '.nglb-close{flex:none;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;border:none;background:transparent;color:#9ca3af;cursor:pointer;font-size:16px;line-height:1;}',
      '.nglb-close:hover{background:rgba(0,0,0,.06);color:#374151;}',
      'html.dark .nglb-close:hover{background:rgba(255,255,255,.08);color:#d1d5db;}',
      '@media (max-width:640px){#nelth-guest-limit-banner{bottom:12px;padding:14px;}}',
    ].join('\n');
    document.head.appendChild(style);
  }

  function showLimitBanner() {
    if (!sessionInfo || !sessionInfo.guest) return;
    if (isAuthPage()) return;
    if (document.getElementById('nelth-guest-limit-banner')) return;
    ensureBannerStyles();

    var wrap = document.createElement('div');
    wrap.id = 'nelth-guest-limit-banner';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', 'Limite du mode invité atteinte');

    var body = document.createElement('div');
    body.className = 'nglb-body';

    var title = document.createElement('p');
    title.className = 'nglb-title';
    title.textContent = 'Limite du mode invité atteinte';

    var text = document.createElement('p');
    text.className = 'nglb-text';
    text.textContent =
      'Créez un compte gratuit pour continuer à discuter sans limites — et débloquer la génération d’images et de vidéos, la recherche web et tous les modèles.';

    var actions = document.createElement('div');
    actions.className = 'nglb-actions';

    var signup = document.createElement('button');
    signup.type = 'button';
    signup.className = 'nglb-btn nglb-btn--signup';
    signup.textContent = 'Créer un compte';
    signup.addEventListener('click', function () {
      goAuth('signup');
    });

    var login = document.createElement('button');
    login.type = 'button';
    login.className = 'nglb-btn nglb-btn--login';
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
    close.className = 'nglb-close';
    close.setAttribute('aria-label', 'Fermer');
    close.textContent = '×';
    close.addEventListener('click', function () {
      wrap.remove();
    });

    wrap.appendChild(body);
    wrap.appendChild(close);
    document.body.appendChild(wrap);
  }

  // ---------------------------------------------------------------------
  // 3ter) Verrous UI invité (les refus RÉELS sont côté serveur — files.ts,
  // retrieval.ts, images.ts 403 : ici on masque les contrôles pour éviter
  // les culs-de-sac). Le SPA re-rend en permanence → ré-appliqué par le
  // MutationObserver (les items du menu « + » n'existent que popover ouvert).
  // ---------------------------------------------------------------------

  /** Libellés d'attachement (menu « + »), préfixes EN + FR. */
  var GUEST_LOCK_PREFIX_RE =
    /^(upload|télévers|import|attach|joindre|attacher|capture|screenshot|caméra|camera|webpage|page web)/i;
  /** Boutons du composeur verrouillés pour les invités (voix, intégrations). */
  var GUEST_LOCK_EXACT = [
    'integrations',
    'intégrations',
    'voice input',
    'saisie vocale',
    'entrée vocale',
    'voice mode',
    'mode vocal',
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
        lockGuestControls();
        scheduleUsageFetch();
      }, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------
  // 4) Hygiène : déconnexion / connexion réussie → stash vidé
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
  // 5) /auth?form=signup → présélection de l'onglet « S'inscrire »
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
    if (sessionInfo && sessionInfo.guest) {
      startUsagePolling();
      lockGuestControls();
    }
  }

  resolveSession().then(function () {
    boot();
  });
})();
