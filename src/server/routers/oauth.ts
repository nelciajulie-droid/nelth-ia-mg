import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { env, ERROR_MESSAGES } from '@/lib/constants';
import { configGet } from '@/lib/config';
import { getPasswordHash } from '@/lib/auth';
import { Users, UserModel } from '@/lib/models/users';
import { Auths, WEBUI_AUTH_COOKIE_SAME_SITE, WEBUI_AUTH_COOKIE_SECURE } from '@/lib/models/auths';
import { FIREBASE_AUTH_ENABLED, firebaseSignInWithIdpGoogle } from '@/lib/firebase-auth';

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
 * credentials are set. /oauth/google/login then redirects back to /auth with
 * an actionable error explaining that GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 * are still missing, instead of a bare 404.
 */
export function publicOAuthProviders(): Record<string, { name: string }> {
  const configured = loadOAuthProviders();
  const providers: Record<string, { name: string }> = {};
  for (const [key, value] of Object.entries(configured)) {
    providers[key] = { name: value.displayName ?? key };
  }
  if (!providers.google) providers.google = { name: 'Google' };
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
  // ------------------- GET /login/{provider} -------------------
  {
    method: 'GET',
    path: ':provider/login',
    auth: 'none',
    handler: async (ctx) => {
      const authConfig = await getOAuthRuntimeConfig();
      const provider = loadOAuthProviders()[ctx.params.provider];

      // Google is always rendered on the auth page: when credentials are
      // missing, redirect back with an actionable error instead of a bare 404
      // so the toast on /auth explains exactly what to configure.
      if (!authConfig.ENABLE_OAUTH || !provider) {
        if (ctx.params.provider === 'google') {
          const detail = !authConfig.ENABLE_OAUTH
            ? 'La connexion Google est désactivée (ENABLE_OAUTH=false)'
            : 'Connexion Google non configurée : renseignez GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans .env puis redémarrez (Console Firebase → Authentication → Fournisseur Google).';
          const base = (await configGet<string>('webui.url', '')) || requestOrigin(ctx.req);
          return redirectResponse(
            `${base.replace(/\/$/, '')}/auth?error=${encodeURIComponent(detail)}`,
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
