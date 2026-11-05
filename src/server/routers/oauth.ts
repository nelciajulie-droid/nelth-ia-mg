import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { env, ERROR_MESSAGES } from '@/lib/constants';
import { configGet } from '@/lib/config';
import { getPasswordHash } from '@/lib/auth';
import { Users, UserModel } from '@/lib/models/users';
import { Auths, WEBUI_AUTH_COOKIE_SAME_SITE, WEBUI_AUTH_COOKIE_SECURE } from '@/lib/models/auths';
import {
  FIREBASE_AUTH_ENABLED,
  firebaseSignInWithIdpGoogle,
  firebaseLookupGoogleIdentity,
  firebaseOauthLink,
} from '@/lib/firebase-auth';

/**
 * Port of the Open WebUI v0.12.5 OAuth login flow (main.py app-level
 * /oauth/{provider}/login + /oauth/{provider}/callback, mounted at /oauth
 * via src/app/oauth/[...path]/route.ts) with generic OAuth2/OIDC support (utils/oauth.py).
 *
 * Default parity: ENABLE_OAUTH is False by default → both endpoints raise the
 * Python bare HTTPException(404) → body {"detail": null}. With no provider
 * configured the same 404 is returned.
 */

const envBool = (key: string, def: string) => (process.env[key] ?? def).toLowerCase() === 'true';

const OAUTH_LOGIN_FAILED =
  'Sign-in with your identity provider failed. Please contact your administrator for assistance.';
const OAUTH_DEFAULT_ERROR = '[ERROR: Error during OAuth process]';
const OAUTH_MAX_SESSIONS_PER_USER = parseInt(process.env.OAUTH_MAX_SESSIONS_PER_USER ?? '10', 10) || 10;

// ---------------------------------------------------------------------------
// Provider registry (config.py load_oauth_providers port)
// ---------------------------------------------------------------------------

type OAuthProvider = {
  name: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  /** OIDC discovery document URL (authlib server_metadata_url). */
  serverMetadataUrl?: string;
  /** Direct endpoints (non-discovery providers). */
  authorizeUrl?: string;
  tokenUrl?: string;
  userinfoEndpoint?: string;
  subClaim?: string;
  redirectUri?: string;
  displayName?: string;
};

function loadOAuthProviders(): Record<string, OAuthProvider> {
  const providers: Record<string, OAuthProvider> = {};

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers['google'] = {
      name: 'google',
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      scope: process.env.GOOGLE_OAUTH_SCOPE || 'openid email profile',
      serverMetadataUrl: 'https://accounts.google.com/.well-known/openid-configuration',
      redirectUri: process.env.GOOGLE_REDIRECT_URI || undefined,
    };
  }

  const msTenant = process.env.MICROSOFT_CLIENT_TENANT_ID || '';
  if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET && msTenant) {
    const loginBase = process.env.MICROSOFT_CLIENT_LOGIN_BASE_URL || 'https://login.microsoftonline.com';
    providers['microsoft'] = {
      name: 'microsoft',
      clientId: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      scope: process.env.MICROSOFT_OAUTH_SCOPE || 'openid email profile',
      serverMetadataUrl: `${loginBase}/${msTenant}/v2.0/.well-known/openid-configuration?appid=${process.env.MICROSOFT_CLIENT_ID}`,
      redirectUri: process.env.MICROSOFT_REDIRECT_URI || undefined,
    };
  }

  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    providers['github'] = {
      name: 'github',
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      scope: process.env.GITHUB_CLIENT_SCOPE || 'user:email',
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      userinfoEndpoint: 'https://api.github.com/user',
      subClaim: 'id',
      redirectUri: process.env.GITHUB_CLIENT_REDIRECT_URI || undefined,
    };
  }

  const oauthClientId = process.env.OAUTH_CLIENT_ID || '';
  const oauthClientSecret = process.env.OAUTH_CLIENT_SECRET || '';
  const codeChallenge = process.env.OAUTH_CODE_CHALLENGE_METHOD || '';
  const openidProviderUrl = process.env.OPENID_PROVIDER_URL || '';
  if (oauthClientId && (oauthClientSecret || codeChallenge) && openidProviderUrl) {
    providers['oidc'] = {
      name: 'oidc',
      clientId: oauthClientId,
      clientSecret: oauthClientSecret,
      scope: process.env.OAUTH_SCOPES || 'openid email profile',
      serverMetadataUrl: openidProviderUrl,
      redirectUri: process.env.OPENID_REDIRECT_URI || undefined,
      displayName: process.env.OAUTH_PROVIDER_NAME || 'SSO',
    };
  }

  if (process.env.FEISHU_CLIENT_ID && process.env.FEISHU_CLIENT_SECRET) {
    providers['feishu'] = {
      name: 'feishu',
      clientId: process.env.FEISHU_CLIENT_ID,
      clientSecret: process.env.FEISHU_CLIENT_SECRET,
      scope: process.env.FEISHU_OAUTH_SCOPE || 'contact:user.base:readonly',
      authorizeUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
      tokenUrl: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
      userinfoEndpoint: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
      subClaim: 'user_id',
      redirectUri: process.env.FEISHU_REDIRECT_URI || undefined,
    };
  }

  return providers;
}

/** Providers advertised to the frontend (GET /api/config → oauth.providers).
 *
 * Google is ALWAYS advertised: the auth page renders the official Google
 * button (multi-colour G logo shipped in the Open WebUI build) even before
 * credentials are set. When classic OAuth credentials are absent but the
 * Firebase bridge is available, the google entry carries mode='firebase-popup'
 * plus the public Firebase web config so /static/google-bridge.js can open the
 * Google popup DIRECTLY on the auth page (one click, no intermediate page).
 */
export function publicOAuthProviders(): Record<
  string,
  {
    name: string;
    mode?: string;
    firebase?: { apiKey: string; authDomain: string; projectId: string };
  }
> {
  const configured = loadOAuthProviders();
  const providers: Record<
    string,
    { name: string; mode?: string; firebase?: { apiKey: string; authDomain: string; projectId: string } }
  > = {};
  for (const [key, value] of Object.entries(configured)) {
    providers[key] = { name: value.displayName ?? key };
  }
  if (!providers.google) {
    providers.google = FIREBASE_AUTH_ENABLED
      ? {
          name: 'Google',
          mode: 'firebase-popup',
          firebase: {
            apiKey: process.env.FIREBASE_API_KEY ?? '',
            authDomain: `${process.env.FIREBASE_PROJECT_ID ?? 'ethan-nairah'}.firebaseapp.com`,
            projectId: process.env.FIREBASE_PROJECT_ID ?? 'ethan-nairah',
          },
        }
      : { name: 'Google' };
  }
  return providers;
}

// ---------------------------------------------------------------------------
// Runtime config (utils/oauth.py get_oauth_runtime_config subset)
// ---------------------------------------------------------------------------

type OAuthRuntimeConfig = {
  ENABLE_OAUTH: boolean;
  ENABLE_OAUTH_SIGNUP: boolean;
  OAUTH_MERGE_ACCOUNTS_BY_EMAIL: boolean;
  OAUTH_SUB_CLAIM: string | null;
  OAUTH_USERNAME_CLAIM: string;
  OAUTH_PICTURE_CLAIM: string;
  OAUTH_EMAIL_CLAIM: string;
  OAUTH_ALLOWED_DOMAINS: string[];
  OAUTH_UPDATE_PICTURE_ON_LOGIN: boolean;
  OAUTH_UPDATE_NAME_ON_LOGIN: boolean;
  OAUTH_UPDATE_EMAIL_ON_LOGIN: boolean;
  OAUTH_AUDIENCE: string;
  JWT_EXPIRES_IN: string;
};

function parseAuthorizeParams(): Record<string, string> {
  const raw = process.env.OAUTH_AUTHORIZE_PARAMS || '';
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function getOAuthRuntimeConfig(): Promise<OAuthRuntimeConfig> {
  return {
    ENABLE_OAUTH: await configGet<boolean>('oauth.enable', env.ENABLE_OAUTH),
    ENABLE_OAUTH_SIGNUP: await configGet<boolean>('oauth.enable_signup', envBool('ENABLE_OAUTH_SIGNUP', 'False')),
    OAUTH_MERGE_ACCOUNTS_BY_EMAIL: await configGet<boolean>(
      'oauth.merge_accounts_by_email',
      envBool('OAUTH_MERGE_ACCOUNTS_BY_EMAIL', 'False')
    ),
    OAUTH_SUB_CLAIM: await configGet<string | null>('oauth.sub_claim', process.env.OAUTH_SUB_CLAIM ?? null),
    OAUTH_USERNAME_CLAIM: await configGet<string>('oauth.username_claim', process.env.OAUTH_USERNAME_CLAIM || 'name'),
    OAUTH_PICTURE_CLAIM: await configGet<string>('oauth.picture_claim', process.env.OAUTH_PICTURE_CLAIM || 'picture'),
    OAUTH_EMAIL_CLAIM: await configGet<string>('oauth.email_claim', process.env.OAUTH_EMAIL_CLAIM || 'email'),
    OAUTH_ALLOWED_DOMAINS: await configGet<string[]>(
      'oauth.allowed_domains',
      (process.env.OAUTH_ALLOWED_DOMAINS || '*')
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean)
    ),
    OAUTH_UPDATE_PICTURE_ON_LOGIN: await configGet<boolean>(
      'oauth.update_picture_on_login',
      envBool('OAUTH_UPDATE_PICTURE_ON_LOGIN', 'False')
    ),
    OAUTH_UPDATE_NAME_ON_LOGIN: await configGet<boolean>(
      'oauth.update_name_on_login',
      envBool('OAUTH_UPDATE_NAME_ON_LOGIN', 'False')
    ),
    OAUTH_UPDATE_EMAIL_ON_LOGIN: await configGet<boolean>(
      'oauth.update_email_on_login',
      envBool('OAUTH_UPDATE_EMAIL_ON_LOGIN', 'False')
    ),
    OAUTH_AUDIENCE: await configGet<string>('oauth.audience', process.env.OAUTH_AUDIENCE || ''),
    JWT_EXPIRES_IN: await configGet<string>('auth.jwt_expiry', env.JWT_EXPIRES_IN),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Request origin honoring proxy headers (starlette base_url approximation). */
function requestOrigin(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host;
  return `${proto}://${host}`;
}

function redirectResponse(location: string, cookies: string[]): Response {
  const headers = new Headers();
  headers.set('location', location);
  headers.set('cache-control', 'no-store');
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 307, headers });
}

function stateCookie(name: string, value: string, maxAge: number): string {
  // Path=/ (starlette set_cookie default): the login endpoint lives at
  // /oauth/{provider}/login and the callback at /oauth/{provider}/callback,
  // so the state cookie must be sent to both — a nested path like
  // /api/v1/oauth would never reach the callback and break state validation.
  let cookie = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${WEBUI_AUTH_COOKIE_SAME_SITE}; Max-Age=${maxAge}`;
  if (WEBUI_AUTH_COOKIE_SECURE) cookie += '; Secure';
  return cookie;
}

function tokenCookie(name: string, value: string, maxAge: number | null, httpOnly: boolean): string {
  let cookie = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=${WEBUI_AUTH_COOKIE_SAME_SITE}`;
  if (httpOnly) cookie += '; HttpOnly';
  if (WEBUI_AUTH_COOKIE_SECURE) cookie += '; Secure';
  if (maxAge !== null && maxAge !== undefined) cookie += `; Max-Age=${Math.floor(maxAge)}`;
  return cookie;
}

function deletedTokenCookie(): string {
  return `token=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=${WEBUI_AUTH_COOKIE_SAME_SITE}`;
}

/** JSON response carrying session cookies (used by the Firebase popup bridge). */
function jsonWithCookies(data: unknown, cookies: string[], status = 200): Response {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

// ---------------------------------------------------------------------------
// Google popup bridge (Firebase Auth) — zero OAuth credentials required.
// ---------------------------------------------------------------------------

/** HTML sign-in page served at /oauth/google/login when GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET are absent but FIREBASE_API_KEY is configured.
 *
 * Instead of the classic OAuth2 code flow (which needs a Web client ID +
 * secret from the Google Cloud Console), this page runs Firebase's Google
 * flow and posts the resulting Google-signed ID token to
 * POST /oauth/google/firebase-token, which verifies it against the Identity
 * Toolkit and issues the exact same session as the OAuth callback.
 *
 * UX — UN SEUL CLIC de bout en bout (comme un vrai endpoint OAuth) : au
 * chargement la page consomme d'abord le résultat d'un éventuel retour de
 * redirection, finit silencieusement si une session Google client existe,
 * et sinon redirige DIRECTEMENT vers accounts.google.com en pleine page
 * (signInWithRedirect n'exige aucun geste utilisateur, seuls les popups en
 * exigent un). L'UI manuelle n'apparaît qu'en cas d'erreur ou de garde
 * anti-boucle déclenchée — jamais dans le flux nominal.
 *
 * Requirements — both already true for this deployment:
 *   • FIREBASE_API_KEY set (server verifies the ID token);
 *   • the current domain authorized in Firebase console (Authentication →
 *     Settings → Authorized domains: localhost, preview and the Vercel
 *     domain are all listed for this project).
 */
function firebaseBridgePage(): Response {
  const apiKey = process.env.FIREBASE_API_KEY ?? '';
  const projectId = process.env.FIREBASE_PROJECT_ID ?? 'ethan-nairah';
  const config = {
    apiKey,
    authDomain: `${projectId}.firebaseapp.com`,
    projectId,
    ...(process.env.FIREBASE_APP_ID ? { appId: process.env.FIREBASE_APP_ID } : {}),
    ...(process.env.FIREBASE_STORAGE_BUCKET
      ? { storageBucket: process.env.FIREBASE_STORAGE_BUCKET }
      : {}),
  };
  const configJson = JSON.stringify(config).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connexion Google — Nelth-AI</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         background:#fafafa; color:#18181b; padding:16px; }
  .card { width:100%; max-width:380px; background:#fff; border:1px solid #e4e4e7; border-radius:16px;
          padding:32px 28px; text-align:center; box-shadow:0 8px 30px rgba(0,0,0,.06); }
  .glogo { width:40px; height:40px; margin:0 auto 16px; display:block; }
  h1 { font-size:18px; margin:0 0 6px; font-weight:600; }
  p.status { color:#71717a; font-size:14px; margin:0 0 20px; min-height:20px; }
  .spinner { width:22px; height:22px; border:3px solid #e4e4e7; border-top-color:#10b981;
             border-radius:50%; animation:spin .8s linear infinite; margin:0 auto 14px; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .err { display:none; background:#fef2f2; border:1px solid #fecaca; color:#b91c1c; border-radius:10px;
         padding:10px 12px; font-size:13px; margin:0 0 16px; text-align:left; }
  button { width:100%; padding:11px 16px; border-radius:10px; border:1px solid #d8d8dc; background:#fff;
           font-size:14px; cursor:pointer; color:#18181b; }
  button.primary { background:#10b981; color:#fff; border-color:#10b981; font-weight:600; }
  button.resume { margin-top:10px; }
  button:hover { filter:brightness(.97); }
  .links { margin-top:14px; font-size:13px; }
  a { color:#0d9488; text-decoration:none; }
</style>
</head>
<body>
<main class="card" aria-label="Connexion Google">
  <svg class="glogo" viewBox="0 0 48 48" role="img" aria-label="Google">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
  </svg>
  <h1>Connexion avec Google</h1>
  <div class="spinner" id="spin"></div>
  <p class="status" id="status">Préparation de la connexion…</p>
  <div class="err" id="err" role="alert"></div>
  <button class="primary" id="go" type="button">Continuer avec Google</button>
  <button class="resume" id="resume" type="button" style="display:none"></button>
  <div class="links"><a href="/auth">← Revenir à la connexion</a></div>
</main>
<script type="application/json" id="fb-config">${configJson}</script>
<script type="module">
const cfg = JSON.parse(document.getElementById('fb-config').textContent);
const el = (id) => document.getElementById(id);
const FB_AUTO_KEY = 'nelthFbAutoRedirectAt';
let fbAuth = null;
let finishing = false;

async function init() {
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
  const auth = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
  const app = initializeApp(cfg);
  fbAuth = auth.getAuth(app);
  return auth;
}

async function finish(user) {
  if (finishing) return;
  finishing = true;
  el('spin').style.display = '';
  el('status').textContent = 'Vérification de votre identité…';
  try {
    const idToken = await user.getIdToken();
    const res = await fetch('/oauth/google/firebase-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || 'La connexion a échoué.');
    window.location.href = data.pending ? '/auth?pending=1' : '/auth';
  } catch (e) {
    finishing = false;
    fail((e && e.message) || 'La connexion a échoué.');
  }
}

function fail(message) {
  el('spin').style.display = 'none';
  el('status').textContent = '';
  el('err').textContent = message;
  el('err').style.display = 'block';
}

function messageFor(e) {
  const code = e && e.code ? String(e.code) : '';
  if (code === 'auth/unauthorized-domain')
    return 'Ce domaine n\u2019est pas autorisé dans la console Firebase (Authentication \u2192 Settings \u2192 Authorized domains).';
  if (code === 'auth/operation-not-allowed' || code === 'auth/configuration-not-found')
    return 'Le fournisseur Google n\u2019est pas activé dans la console Firebase (Authentication \u2192 Sign-in method \u2192 Google).';
  if (code === 'auth/popup-blocked')
    return 'Le navigateur a bloqué la fenêtre Google. Autorisez les popups pour ce site puis cliquez sur « Continuer avec Google ».';
  if (code === 'auth/network-request-failed')
    return 'Réseau indisponible — vérifiez votre connexion puis réessayez.';
  return (e && e.message ? e.message : 'Erreur inconnue.');
}

function ready(statusText) {
  el('spin').style.display = 'none';
  el('status').textContent = statusText || 'Cliquez sur « Continuer avec Google ».';
}

// Button click (real user gesture, UI manuelle de secours) : popup d'abord,
// redirection pleine page en repli pour les navigateurs qui bloquent les
// popups. Le sélecteur de compte Google est forcé ici — c'est le chemin
// « changer de compte » quand une session client existe déjà.
async function start() {
  if (finishing) return;
  try {
    el('err').style.display = 'none';
    el('spin').style.display = '';
    el('status').textContent = 'Ouverture de la fenêtre Google…';
    const { GoogleAuthProvider, signInWithPopup, signInWithRedirect } =
      await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      const cred = await signInWithPopup(fbAuth, provider);
      await finish(cred.user);
    } catch (e) {
      if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) {
        el('status').textContent = 'Redirection vers Google…';
        await signInWithRedirect(fbAuth, provider);
        return;
      }
      throw e;
    }
  } catch (e) {
    if (e && (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request')) {
      ready('Fenêtre fermée — cliquez pour recommencer.');
      return;
    }
    fail(messageFor(e));
  }
}

// One-click resume when Firebase still has the Google session client-side
// (localStorage persistence) — no Google round-trip needed at all.
async function resume() {
  if (fbAuth && fbAuth.currentUser) await finish(fbAuth.currentUser);
}

document.getElementById('go').addEventListener('click', start);
document.getElementById('resume').addEventListener('click', resume);

(async () => {
  try {
    // Paramètre de repli depuis l'intercepteur un-clic (google-bridge.js) :
    //   ?err=<msg> → erreur du popup côté /auth : l'afficher et ne rien
    //   démarrer automatiquement. (?auto=1 est désormais superflu : toute
    //   visite fraîche de la page enchaîne automatiquement en redirection.)
    const params = new URLSearchParams(window.location.search);
    const errParam = params.get('err');
    if (errParam) fail(errParam);

    const { getRedirectResult } = await init();

    // 1. Retour de accounts.google.com (signInWithRedirect) : consommer le
    //    résultat D'ABORD et exclusivement — rien d'autre ne doit démarrer
    //    une nouvelle connexion ici, sinon l'utilisateur rebondit vers le
    //    account chooser dans une boucle infinie.
    try {
      const cred = await getRedirectResult(fbAuth);
      if (cred && cred.user) {
        sessionStorage.removeItem(FB_AUTO_KEY);
        await finish(cred.user);
        return;
      }
    } catch (e) {
      if (e && e.code && !String(e.code).includes('cancelled')) fail(messageFor(e));
    }

    // 2. Session Google encore active côté client (persistance Firebase
    //    locale) → finition SILENCIEUSE : le clic « Continue with Google »
    //    de /auth reste un seul clic, sans même repasser par Google.
    const current = fbAuth.currentUser;
    if (current && !errParam) {
      await finish(current);
      return;
    }

    // 3. Visite fraîche (le clic vient de /auth, l'intercepteur popup n'a pas
    //    abouti) → redirection pleine page DIRECTE vers Google. Aucun geste
    //    requis pour signInWithRedirect, donc zéro page intermédiaire.
    //    Garde anti-boucle : pas de nouvelle auto-redirection si la précédente
    //    date de moins de 60 s (retour sans résultat ≠ recommencer en boucle).
    const last = Number(sessionStorage.getItem(FB_AUTO_KEY) || 0);
    const recent = last > 0 && Date.now() - last < 60000;
    if (!errParam && !recent) {
      sessionStorage.setItem(FB_AUTO_KEY, String(Date.now()));
      el('status').textContent = 'Redirection vers Google…';
      const { GoogleAuthProvider, signInWithRedirect } =
        await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
      await signInWithRedirect(fbAuth, new GoogleAuthProvider());
      return;
    }

    // 4. Garde anti-boucle déclenchée ou erreur affichée → UI manuelle
    //    (popup au clic, sélecteur de compte forcé).
    if (current) {
      const label = current.displayName || current.email || 'votre compte Google';
      el('resume').textContent = 'Continuer en tant que ' + label;
      el('resume').style.display = '';
      el('go').textContent = 'Choisir un autre compte Google';
    }
    ready(recent ? 'Connexion interrompue — cliquez pour recommencer.' : undefined);
  } catch (e) {
    fail(messageFor(e));
  }
})();
</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function parseDuration(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (!s || s === '-1' || s === 'none' || s === 'never') return null;
  const m = s.match(/^(\d+)\s*(s|m|h|d|w|y)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };
  return n * mult[m[2]];
}

type Discovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
};

async function getDiscovery(provider: OAuthProvider): Promise<Discovery> {
  if (provider.serverMetadataUrl) {
    const url = provider.serverMetadataUrl.replace(/\/$/, '');
    const metadataUrl = url.endsWith('/.well-known/openid-configuration')
      ? url
      : `${url}/.well-known/openid-configuration`;
    const res = await fetch(metadataUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Failed to fetch OpenID configuration (HTTP ${res.status})`);
    const doc = await res.json();
    if (!doc.authorization_endpoint || !doc.token_endpoint) {
      throw new Error('OpenID configuration is missing endpoints');
    }
    return doc;
  }
  if (provider.authorizeUrl && provider.tokenUrl) {
    return {
      authorization_endpoint: provider.authorizeUrl,
      token_endpoint: provider.tokenUrl,
      userinfo_endpoint: provider.userinfoEndpoint,
    };
  }
  throw new Error('OAuth provider is not configured');
}

/** Decode an unverified JWT payload (id_token claims). */
function decodeIdToken(idToken: string): Record<string, any> | null {
  try {
    const payload = idToken.split('.')[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

async function fetchGithubPrimaryEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.github.com/user/emails', {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const emails = (await res.json()) as Array<{ email: string; primary: boolean }>;
    return emails.find((e) => e.primary)?.email ?? null;
  } catch {
    return null;
  }
}

function cookieValue(req: Request, name: string): string | null {
  const cookie = req.headers.get('cookie');
  if (!cookie) return null;
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Session token (mirrors create_signin_response with source='oauth')
// ---------------------------------------------------------------------------

async function issueSession(user: UserModel): Promise<{ token: string; expiresAt: number | null; expiresDelta: number | null }> {
  const { createToken } = await import('@/lib/auth');
  const { getAuthOrThrow } = await import('@/lib/models/auths');
  const auth = await getAuthOrThrow(user.id);
  const expiresDelta = parseDuration(await configGet<string>('auth.jwt_expiry', env.JWT_EXPIRES_IN));
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = expiresDelta ? now + Math.floor(expiresDelta) : null;
  const token = createToken(
    {
      id: user.id,
      typ: 'session',
      auth_method: 'oauth',
      auth_time: now,
      session_stamp: auth.session_stamp,
      mfa_verified: false,
    },
    expiresDelta
  );
  return { token, expiresAt, expiresDelta };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Bare HTTPException(404) → {"detail": null}. */
function notFoundNull(ctx: Ctx): Response {
  return ctx.json({ detail: null }, 404);
}

export const routes: Route[] = [
  // ------------------- POST /google/firebase-token -------------------
  // Google popup bridge endpoint: the HTML page at /oauth/google/login runs
  // Firebase signInWithPopup in the browser and posts the resulting Google-
  // signed ID token here. The token is verified server-side via the Identity
  // Toolkit (accounts:lookup) — a cryptographic proof of the identity — and
  // the exact same account-resolution + session logic as the OAuth callback
  // runs (Google sub lookup → email merge → signup keyed by the Firebase UID).
  {
    method: 'POST',
    path: 'google/firebase-token',
    auth: 'none',
    handler: async (ctx) => {
      const authConfig = await getOAuthRuntimeConfig();
      if (!authConfig.ENABLE_OAUTH) return notFoundNull(ctx);
      if (!FIREBASE_AUTH_ENABLED) {
        return ctx.json(
          { detail: 'Pont Firebase indisponible : FIREBASE_API_KEY absente.' },
          400
        );
      }

      const body = await ctx.body<{ idToken?: unknown }>().catch(() => ({}) as { idToken?: unknown });
      const idToken = typeof body?.idToken === 'string' ? body.idToken : '';
      const identity = await firebaseLookupGoogleIdentity(idToken);
      if (!identity) {
        return ctx.json({ detail: OAUTH_LOGIN_FAILED }, 400);
      }
      const { uid, googleSub, email, displayName, photoUrl } = identity;

      // Allowed-domain gate (same as the OAuth callback).
      if (
        !authConfig.OAUTH_ALLOWED_DOMAINS.includes('*') &&
        !authConfig.OAUTH_ALLOWED_DOMAINS.includes(email.split('@').pop() ?? '')
      ) {
        return ctx.json({ detail: OAUTH_LOGIN_FAILED }, 400);
      }

      // User resolution mirrors the OAuth callback: Google sub → email merge → signup.
      let user = await Users.getUserByOauthSub('google', googleSub);
      if (!user && authConfig.OAUTH_MERGE_ACCOUNTS_BY_EMAIL) {
        const byEmail = await Users.getUserByEmail(email);
        if (byEmail) {
          user = (await Users.updateUserOauthById(byEmail.id, 'google', googleSub)) ?? byEmail;
        }
      }
      if (user) {
        const oauthRecord =
          user.oauth && typeof user.oauth === 'object' ? (user.oauth as Record<string, any>) : {};
        if (oauthRecord.google && typeof oauthRecord.google === 'object' && oauthRecord.google.sub !== googleSub) {
          // Lazy repair for legacy rows with mismatched subs
          user = (await Users.updateUserOauthById(user.id, 'google', googleSub)) ?? user;
        }
        // Keep the Firebase identity link fresh — proper object merge so the
        // password sign-in bridge can find the UID later (never a string that
        // would double-encode the JSON column).
        const currentRecord =
          user.oauth && typeof user.oauth === 'object' ? (user.oauth as Record<string, any>) : {};
        if (currentRecord.firebase?.uid !== uid) {
          user =
            (await Users.updateUserById(user.id, {
              oauth: {
                ...currentRecord,
                google: { ...(currentRecord.google ?? {}), sub: googleSub },
                firebase: firebaseOauthLink({ uid, email }),
              },
            })) ?? user;
        }
      } else if (authConfig.ENABLE_OAUTH_SIGNUP) {
        const existingUser = await Users.getUserByEmail(email);
        if (existingUser) return ctx.json({ detail: ERROR_MESSAGES.EMAIL_TAKEN }, 400);

        const created = await Auths.insertNewAuth(
          email,
          await getPasswordHash(crypto.randomUUID()),
          displayName || email,
          photoUrl || '/user.png',
          await configGet<string>('ui.default_user_role', env.DEFAULT_USER_ROLE),
          { google: { sub: googleSub }, firebase: firebaseOauthLink({ uid, email }) },
          uid
        );
        if (!created) return ctx.json({ detail: ERROR_MESSAGES.CREATE_USER_ERROR }, 500);
        user = created;

        if ((await Users.getNumUsers()) === 1) {
          await Users.updateUserRoleById(user.id, 'admin');
          user = (await Users.getUserById(user.id)) ?? user;
        }
      } else {
        return ctx.json({ detail: ERROR_MESSAGES.ACCESS_PROHIBITED }, 403);
      }

      // Store the OAuth session (provider idToken — same pruning as the callback).
      const nowSec = Math.floor(Date.now() / 1000);
      try {
        const existing = await db.oAuthSession.findMany({ where: { user_id: user.id, provider: 'google' } });
        const sorted = existing.sort((a, b) => a.created_at - b.created_at).reverse();
        if (sorted.length >= OAUTH_MAX_SESSIONS_PER_USER) {
          for (const old of sorted.slice(OAUTH_MAX_SESSIONS_PER_USER - 1)) {
            await db.oAuthSession.delete({ where: { id: old.id } }).catch(() => undefined);
          }
        }
        await db.oAuthSession.create({
          data: {
            id: crypto.randomUUID(),
            user_id: user.id,
            provider: 'google',
            token: JSON.stringify({ firebase_idToken: idToken.slice(0, 2048) }),
            expires_at: nowSec + 3600,
            created_at: nowSec,
            updated_at: nowSec,
          },
        });
      } catch {
        // Failed session storage must not block sign-in (Python parity).
      }

      // Pending users cannot receive a session (create_signin_response next_step).
      if (!['admin', 'user'].includes(user.role)) {
        return jsonWithCookies({ pending: true }, [deletedTokenCookie()]);
      }

      const session = await issueSession(user);
      const maxAge = session.expiresDelta ? Math.floor(session.expiresDelta) : null;
      return jsonWithCookies({ ok: true }, [tokenCookie('token', session.token, maxAge, false)]);
    },
  },

  // ------------------- GET /login/{provider} -------------------
  {
    method: 'GET',
    path: ':provider/login',
    auth: 'none',
    handler: async (ctx) => {
      const authConfig = await getOAuthRuntimeConfig();
      const provider = loadOAuthProviders()[ctx.params.provider];

      // Google is always rendered on the auth page. When credentials are
      // missing, the Firebase popup bridge (FIREBASE_API_KEY) serves a
      // zero-configuration sign-in page; only when neither is available do we
      // redirect back with an actionable error — including the deploy target
      // (.env locally vs Vercel env vars in production) and the exact redirect
      // URI that must be whitelisted in Google Cloud Console.
      if (!authConfig.ENABLE_OAUTH || !provider) {
        if (ctx.params.provider === 'google') {
          if (authConfig.ENABLE_OAUTH && !provider && FIREBASE_AUTH_ENABLED) {
            return firebaseBridgePage();
          }
          const base = ((await configGet<string>('webui.url', '')) || requestOrigin(ctx.req)).replace(/\/$/, '');
          const detail = !authConfig.ENABLE_OAUTH
            ? 'La connexion Google est désactivée (ENABLE_OAUTH=false)'
            : `Connexion Google non configurée : renseignez GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET (Console Firebase → Authentication → Fournisseur Google) — via .env en local, ou Settings → Environment Variables sur Vercel en production — puis autorisez l'URI de redirection ${base}/oauth/google/callback dans Google Cloud Console (Credentials → URI de redirection autorisés).`;
          return redirectResponse(
            `${base}/auth?error=${encodeURIComponent(detail)}`,
            []
          );
        }
        return notFoundNull(ctx);
      }

      let discovery: Discovery;
      try {
        discovery = await getDiscovery(provider);
      } catch {
        // authlib would fail during the redirect; surface the same 404-ish failure
        return notFoundNull(ctx);
      }

      const redirectUri =
        provider.redirectUri || `${requestOrigin(ctx.req)}/oauth/${provider.name}/callback`;

      const state = crypto.randomUUID().replace(/-/g, '');
      const nonce = crypto.randomUUID().replace(/-/g, '');

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: provider.clientId,
        redirect_uri: redirectUri,
        scope: provider.scope,
        state,
        nonce,
      });
      if (authConfig.OAUTH_AUDIENCE) params.set('audience', authConfig.OAUTH_AUDIENCE);
      for (const [key, value] of Object.entries(parseAuthorizeParams())) params.set(key, value);

      // State is validated against the short-lived oauth_state cookie set by
      // /login (authlib session-backed state parity).
      return redirectResponse(`${discovery.authorization_endpoint}?${params.toString()}`, [
        stateCookie('oauth_state', state, 600),
      ]);
    },
  },

  // ------------------- GET /callback/{provider} -------------------
  {
    method: 'GET',
    path: ':provider/callback',
    auth: 'none',
    handler: async (ctx) => {
      const authConfig = await getOAuthRuntimeConfig();
      if (!authConfig.ENABLE_OAUTH) return notFoundNull(ctx);
      const provider = loadOAuthProviders()[ctx.params.provider];
      if (!provider) return notFoundNull(ctx);

      const redirectBase = (await configGet<string>('webui.url', '')) || requestOrigin(ctx.req);
      const redirectUrl = `${redirectBase.replace(/\/$/, '')}/auth`;

      // Errors inside the OAuth process are converted to a redirect with
      // ?error=<detail> (Python handle_callback catch-all behavior).
      const fail = (detail: string): Response =>
        redirectResponse(`${redirectUrl}?error=${encodeURIComponent(detail)}`, []);

      try {
        const code = ctx.query.get('code');
        const state = ctx.query.get('state');
        const providerError = ctx.query.get('error');

        if (providerError) throw new HttpError(400, OAUTH_LOGIN_FAILED);
        if (!code) throw new HttpError(400, OAUTH_LOGIN_FAILED);

        // State validation (authlib authorize_access_token parity).
        const expectedState = cookieValue(ctx.req, 'oauth_state');
        if (!state || !expectedState || state !== expectedState) {
          throw new HttpError(400, OAUTH_LOGIN_FAILED);
        }

        const discovery = await getDiscovery(provider);
        const redirectUri =
          provider.redirectUri || `${requestOrigin(ctx.req)}/oauth/${provider.name}/callback`;

        // Exchange the authorization code for tokens.
        const tokenForm = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: provider.clientId,
        });
        if (provider.clientSecret) tokenForm.set('client_secret', provider.clientSecret);

        const tokenRes = await fetch(discovery.token_endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: tokenForm.toString(),
          signal: AbortSignal.timeout(30_000),
        });
        if (!tokenRes.ok) throw new HttpError(400, OAUTH_LOGIN_FAILED);
        const token = (await tokenRes.json()) as Record<string, any>;
        if (!token.access_token) throw new HttpError(400, OAUTH_LOGIN_FAILED);

        // userinfo: id_token claims first, then the userinfo endpoint.
        let userData: Record<string, any> | null = null;
        const idTokenClaims = token.id_token ? decodeIdToken(String(token.id_token)) : null;
        if (idTokenClaims) userData = { ...idTokenClaims };

        const needsUserinfo =
          !userData ||
          !(authConfig.OAUTH_EMAIL_CLAIM in userData) ||
          !(authConfig.OAUTH_USERNAME_CLAIM in userData);
        if (needsUserinfo && discovery.userinfo_endpoint) {
          const userinfoRes = await fetch(discovery.userinfo_endpoint, {
            headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' },
            signal: AbortSignal.timeout(15_000),
          });
          if (userinfoRes.ok) {
            const fetched = await userinfoRes.json();
            if (fetched && typeof fetched === 'object') {
              const merged = { ...(userData ?? {}) };
              for (const [key, value] of Object.entries(fetched)) {
                if (!(key in merged)) merged[key] = value; // userinfo wins in Python
                else if (merged[key] === undefined || merged[key] === null) merged[key] = value;
              }
              userData = merged;
            }
          }
        }
        if (provider.name === 'feishu' && userData && 'data' in userData && typeof userData.data === 'object') {
          userData = userData.data;
        }
        if (!userData) throw new HttpError(400, OAUTH_LOGIN_FAILED);

        // sub extraction
        const subClaim =
          authConfig.OAUTH_SUB_CLAIM ?? provider.subClaim ?? 'sub';
        let sub = userData[subClaim];
        if (sub === undefined || sub === null) sub = userData['sub'];
        if (sub === undefined || sub === null) throw new HttpError(400, OAUTH_LOGIN_FAILED);
        sub = String(sub);

        // email extraction
        let email = String(userData[authConfig.OAUTH_EMAIL_CLAIM] ?? '');
        if (!email) {
          if (provider.name === 'github') {
            const primary = await fetchGithubPrimaryEmail(String(token.access_token));
            if (!primary) throw new HttpError(400, OAUTH_LOGIN_FAILED);
            email = primary;
          } else if (envBool('ENABLE_OAUTH_EMAIL_FALLBACK', 'False')) {
            email = `${provider.name}@${sub}.local`;
          } else {
            throw new HttpError(400, OAUTH_LOGIN_FAILED);
          }
        }
        email = email.toLowerCase();
        if (
          !authConfig.OAUTH_ALLOWED_DOMAINS.includes('*') &&
          !authConfig.OAUTH_ALLOWED_DOMAINS.includes(email.split('@').pop() ?? '')
        ) {
          throw new HttpError(400, OAUTH_LOGIN_FAILED);
        }

        // Firebase bridge (best-effort): mint/link the Google identity in
        // Firebase so the account shares the same lifecycle as email/password
        // accounts. The Firebase UID becomes the account ID (user.id); on any
        // failure (Google provider disabled in the Firebase console, network…)
        // we simply keep the provider's own sub.
        let firebaseUid: string | null = null;
        if (provider.name === 'google' && FIREBASE_AUTH_ENABLED && token.access_token) {
          const firebaseAccount = await firebaseSignInWithIdpGoogle(String(token.access_token));
          if (firebaseAccount) firebaseUid = firebaseAccount.uid;
        }

        // User resolution: oauth sub → email merge → signup
        let user = await Users.getUserByOauthSub(provider.name, sub);
        if (!user && authConfig.OAUTH_MERGE_ACCOUNTS_BY_EMAIL) {
          const byEmail = await Users.getUserByEmail(email);
          if (byEmail) {
            user = (await Users.updateUserOauthById(byEmail.id, provider.name, sub)) ?? byEmail;
          }
        }
        if (user) {
          // Lazy repair for legacy rows with mismatched subs
          const providerOauth = user.oauth?.[provider.name];
          if (providerOauth && typeof providerOauth === 'object' && providerOauth.sub !== sub) {
            user = (await Users.updateUserOauthById(user.id, provider.name, sub)) ?? user;
          }
          if (authConfig.OAUTH_UPDATE_NAME_ON_LOGIN) {
            const newName = userData[authConfig.OAUTH_USERNAME_CLAIM];
            if (newName && newName !== user.name) {
              user = (await Users.updateUserById(user.id, { name: String(newName) })) ?? user;
            }
          }
          if (authConfig.OAUTH_UPDATE_EMAIL_ON_LOGIN) {
            const newEmail = String(userData[authConfig.OAUTH_EMAIL_CLAIM] ?? '').toLowerCase();
            if (newEmail && newEmail !== (user.email ?? '').toLowerCase()) {
              const existing = await Users.getUserByEmail(newEmail);
              if (!existing) {
                if (await Auths.updateEmailById(user.id, newEmail)) {
                  user = (await Users.getUserById(user.id)) ?? user;
                }
              }
            }
          }
          if (authConfig.OAUTH_UPDATE_PICTURE_ON_LOGIN) {
            const picture = String(userData[authConfig.OAUTH_PICTURE_CLAIM] ?? '');
            if (picture && picture !== user.profile_image_url) {
              user = (await Users.updateUserProfileImageUrlById(user.id, picture)) ?? user;
            }
          }
        } else if (authConfig.ENABLE_OAUTH_SIGNUP) {
          const existingUser = await Users.getUserByEmail(email);
          if (existingUser) throw new HttpError(400, ERROR_MESSAGES.EMAIL_TAKEN);

          const pictureUrl = String(userData[authConfig.OAUTH_PICTURE_CLAIM] ?? '') || '/user.png';
          let name = userData[authConfig.OAUTH_USERNAME_CLAIM];
          if (!name) name = email;

          const created = await Auths.insertNewAuth(
            email,
            await getPasswordHash(crypto.randomUUID()),
            String(name),
            pictureUrl,
            await configGet<string>('ui.default_user_role', env.DEFAULT_USER_ROLE),
            { [provider.name]: { sub } },
            firebaseUid ?? undefined
          );
          if (!created) throw new HttpError(500, ERROR_MESSAGES.CREATE_USER_ERROR);
          user = created;

          if ((await Users.getNumUsers()) === 1) {
            await Users.updateUserRoleById(user.id, 'admin');
            user = (await Users.getUserById(user.id)) ?? user;
          }
        } else {
          throw new HttpError(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
        }

        // Store the OAuth session (OAuthSessions.create_session + pruning).
        const nowSec = Math.floor(Date.now() / 1000);
        const expiresIn = token.expires_in ? Number(token.expires_in) : null;
        const expiresAt = expiresIn ? nowSec + Math.floor(expiresIn) : 253402300799;
        let sessionId: string | null = null;
        try {
          const existing = await db.oAuthSession.findMany({ where: { user_id: user.id, provider: provider.name } });
          const sorted = existing.sort((a, b) => a.created_at - b.created_at).reverse();
          if (sorted.length >= OAUTH_MAX_SESSIONS_PER_USER) {
            for (const old of sorted.slice(OAUTH_MAX_SESSIONS_PER_USER - 1)) {
              await db.oAuthSession.delete({ where: { id: old.id } }).catch(() => undefined);
            }
          }
          const session = await db.oAuthSession.create({
            data: {
              id: crypto.randomUUID(),
              user_id: user.id,
              provider: provider.name,
              token: JSON.stringify(token),
              expires_at: expiresAt,
              created_at: nowSec,
              updated_at: nowSec,
            },
          });
          sessionId = session.id;
        } catch {
          // Failed session storage must not block sign-in (Python parity).
        }

        // Pending users cannot receive a session (create_signin_response next_step).
        if (!['admin', 'user'].includes(user.role)) {
          return redirectResponse(`${redirectUrl}?pending=1`, [deletedTokenCookie()]);
        }

        const session = await issueSession(user);
        const maxAge = session.expiresDelta ? Math.floor(session.expiresDelta) : null;
        const cookies = [tokenCookie('token', session.token, maxAge, false)];
        if (sessionId) cookies.push(tokenCookie('oauth_session_id', sessionId, maxAge, true));
        if (token.id_token && envBool('ENABLE_OAUTH_ID_TOKEN_COOKIE', 'True')) {
          cookies.push(tokenCookie('oauth_id_token', String(token.id_token), maxAge, true));
        }
        return redirectResponse(redirectUrl, cookies);
      } catch (e) {
        const rawDetail = e instanceof HttpError && e.detail ? e.detail : OAUTH_DEFAULT_ERROR;
        const detail = typeof rawDetail === 'string' ? rawDetail : JSON.stringify(rawDetail);
        return fail(detail);
      }
    },
  },
];
