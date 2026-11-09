import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { nowNs, uuid } from '@/lib/models/workspace';
import { APP_REGISTRY, getAppById } from '@/lib/apps/app-registry';
import type { AppDefinition, AppConnection, ConnectorListItem } from '@/lib/apps/app-types';
import { WEBUI_AUTH_COOKIE_SAME_SITE, WEBUI_AUTH_COOKIE_SECURE } from '@/lib/models/auths';
import { googleCredsConfigured } from '@/lib/connectors/google';
import {
  googleClientId,
  googleClientSecret,
  googleConnectorRedirectUri,
} from '@/lib/apps/google-oauth-defaults';

/**
 * @ App mention picker — HTTP surface. /api/v1/connectors/*
 *
 *   GET    /                → registry + REAL per-user connection status
 *                              (connector_connection table — never invented)
 *   POST   /:id/connect     → connection flow start: OAuth redirect URL built
 *                              from the SAME provider credentials the login
 *                              OAuth router uses (GOOGLE_CLIENT_ID… — no
 *                              duplicate OAuth system), or a structured
 *                              "not configured" answer listing the env vars.
 *   GET    /:id/callback    → OAuth callback: validates the state cookie,
 *                              exchanges the code, upserts the connection.
 *
 * Google round-trip: the user's Cloud client authorizes ONLY the production
 * root as redirect URI (lib/apps/google-oauth-defaults.ts) — Google lands the
 * code+state on "/" and loader.js forwards them to /:id/callback (the state
 * cookie rides along: Path=/, same-origin fetch). When the redirect's origin
 * doesn't match the requesting origin (sandbox/localhost), /:id/connect
 * answers an actionable message instead of a redirect that could never
 * complete (the state cookie would live on the other origin).
 *   DELETE /:id             → disconnect.
 *
 * Built-in connectors (web_search) need no connection — always `ready`.
 */

function err(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

function requestOrigin(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host;
  return `${proto}://${host}`;
}

function stateCookie(value: string, maxAge: number): string {
  // Path=/ parity with the login OAuth state cookie: the connect endpoint
  // (/api/v1/connectors/{id}/connect) and the callback
  // (/api/v1/connectors/{id}/callback) must both receive it.
  let cookie = `connector_oauth_state=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${WEBUI_AUTH_COOKIE_SAME_SITE}; Max-Age=${maxAge}`;
  if (WEBUI_AUTH_COOKIE_SECURE) cookie += '; Secure';
  return cookie;
}

function cookieValue(req: Request, name: string): string | null {
  const raw = req.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Provider credentials — REUSED from the login OAuth router env contract
// (routers/oauth.ts loadOAuthProviders): same env vars, no second secret
// store. Slack and Notion follow the same {PROVIDER}_CLIENT_ID convention.
// ---------------------------------------------------------------------------

type ProviderEndpoints = {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Extra authorize params (Slack user_scope, Notion owner=user…). */
  extraAuthorizeParams?: Record<string, string>;
  /** Slack: scopes ride as user_scope; Notion/GitHub/Google/MS: scope. */
  scopeParam?: 'scope' | 'user_scope';
  /** Notion: token request uses HTTP Basic auth. */
  tokenAuth?: 'basic' | 'body';
};

const ENV_BY_PROVIDER: Record<string, string[]> = {
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  microsoft: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_CLIENT_TENANT_ID'],
  github: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
  slack: ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET'],
  notion: ['NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET'],
};

function providerCredentials(provider: string): ProviderEndpoints | null {
  if (provider === 'google') {
    // Real user credentials (env GOOGLE_CLIENT_ID/SECRET first, committed
    // defaults otherwise — see lib/apps/google-oauth-defaults.ts).
    if (!googleClientId() || !googleClientSecret()) return null;
    return {
      clientId: googleClientId(),
      clientSecret: googleClientSecret(),
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
    };
  }
  if (provider === 'microsoft') {
    const tenant = process.env.MICROSOFT_CLIENT_TENANT_ID;
    if (!process.env.MICROSOFT_CLIENT_ID || !process.env.MICROSOFT_CLIENT_SECRET || !tenant) return null;
    const base = process.env.MICROSOFT_CLIENT_LOGIN_BASE_URL || 'https://login.microsoftonline.com';
    return {
      clientId: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      authorizeUrl: `${base}/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `${base}/${tenant}/oauth2/v2.0/token`,
    };
  }
  if (provider === 'github') {
    if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) return null;
    return {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
    };
  }
  if (provider === 'slack') {
    if (!process.env.SLACK_CLIENT_ID || !process.env.SLACK_CLIENT_SECRET) return null;
    return {
      clientId: process.env.SLACK_CLIENT_ID,
      clientSecret: process.env.SLACK_CLIENT_SECRET,
      authorizeUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      // Slack user tokens: scopes ride as user_scope (bot scope stays empty).
      scopeParam: 'user_scope',
    };
  }
  if (provider === 'notion') {
    if (!process.env.NOTION_CLIENT_ID || !process.env.NOTION_CLIENT_SECRET) return null;
    return {
      clientId: process.env.NOTION_CLIENT_ID,
      clientSecret: process.env.NOTION_CLIENT_SECRET,
      authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
      tokenUrl: 'https://api.notion.com/v1/oauth/token',
      extraAuthorizeParams: { owner: 'user' },
      tokenAuth: 'basic',
    };
  }
  return null;
}

/** Redirect URI sent to the provider — authorize AND token exchange must
 * carry the exact same value. Google: the single root URI its Cloud client
 * authorizes (loader.js forwards the root return to the callback). Others:
 * the origin-based callback, navigated to directly. */
function connectorRedirectUri(provider: string, origin: string, appId: string): string {
  if (provider === 'google') return googleConnectorRedirectUri();
  return `${origin}/api/v1/connectors/${appId}/callback`;
}

// ---------------------------------------------------------------------------
// Connection status — the single truth, read from the database.
// ---------------------------------------------------------------------------

type ConnectionRow = {
  id: string;
  user_id: string;
  connector_id: string;
  status: string;
  provider: string | null;
  account: string | null;
  scopes: string | null;
  created_at: number;
  updated_at: number;
};

async function connectionsFor(userId: string): Promise<Map<string, ConnectionRow>> {
  const rows = (await db.connectorConnection.findMany({
    where: { user_id: userId },
  })) as unknown as ConnectionRow[];
  return new Map(rows.map((row) => [row.connector_id, row]));
}

function connectionOf(app: AppDefinition, row: ConnectionRow | undefined): AppConnection {
  if (app.builtin) return { status: 'ready', account: null, connected_at: null };
  if (!row) return { status: 'disconnected', account: null, connected_at: null };
  // Rows the provider revoked / that expired surface as-is — never as
  // "connected" (the picker shows the real state).
  const status =
    row.status === 'connected' ? 'connected' : row.status === 'expired' ? 'disconnected' : 'disconnected';
  return {
    status,
    account: row.account ?? null,
    connected_at: row.created_at ?? null,
  };
}

function listItem(app: AppDefinition, row: ConnectionRow | undefined): ConnectorListItem {
  return {
    ...app,
    connection: connectionOf(app, row),
    oauth_configured: app.builtin || (app.oauthProvider ? providerCredentials(app.oauthProvider) !== null : false),
  };
}

/** True when the connector EXECUTES real data for every user on this
 *  instance — the built-in Google connectors run real API calls through the
 *  server's refresh-token account (lib/connectors/google.ts) whenever
 *  GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN are set.
 *  Surfaced as the apps' connection status — never invented. */
function serverConnectorConnected(app: AppDefinition): boolean {
  if (app.oauthProvider === 'google' && googleCredsConfigured()) return true;
  return false;
}

function listItemWithServerState(app: AppDefinition, row: ConnectionRow | undefined): ConnectorListItem {
  const item = listItem(app, row);
  if (serverConnectorConnected(app) && item.connection.status !== 'connected') {
    item.connection = { status: 'connected', account: 'Compte Google du serveur', connected_at: null };
  }
  return item;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // ------------------- GET / (registry + live statuses) -------------------
  {
    method: 'GET',
    path: '',
    auth: 'user',
    handler: async (ctx) => {
      const byConnector = await connectionsFor(ctx.user!.id);
      return ctx.json({
        connectors: APP_REGISTRY.map((app) => listItemWithServerState(app, byConnector.get(app.id))),
      });
    },
  },

  // ------------------- POST /:id/connect (connection flow) -------------------
  {
    method: 'POST',
    path: ':id/connect',
    auth: 'user',
    handler: async (ctx) => {
      const app = getAppById(ctx.params.id);
      if (!app) err(404, 'Connector not found');
      if (app.builtin) err(400, 'Ce connecteur est intégré — aucune connexion nécessaire.');
      if (serverConnectorConnected(app)) {
        err(400, `${app.name} est déjà actif via le compte Google configuré sur le serveur — aucune connexion nécessaire.`);
      }

      const provider = app.oauthProvider!;
      const creds = providerCredentials(provider);
      if (!creds) {
        const env = ENV_BY_PROVIDER[provider] ?? [];
        const origin = requestOrigin(ctx.req);
        return ctx.json({
          status: 'not_configured',
          detail:
            `Connexion ${app.name} non configurée sur cette instance : renseignez ${env.join(' et ')} ` +
            `(.env en local, Settings → Environment Variables sur Vercel) — les mêmes identifiants que la ` +
            `connexion OAuth de login — puis autorisez l'URI de redirection ${origin}/api/v1/connectors/${app.id}/callback ` +
            `auprès du fournisseur.`,
          env,
        });
      }

      const origin = requestOrigin(ctx.req);
      const redirectUri = connectorRedirectUri(provider, origin, app.id);

      // Google redirects ONLY to the URI its Cloud client authorizes (the
      // production root). Starting the flow from another origin (sandbox,
      // localhost) would strand the state cookie on the wrong origin — the
      // return could never validate. Say so instead of a dead-end redirect.
      if (provider === 'google') {
        let redirectOrigin = '';
        try {
          redirectOrigin = new URL(redirectUri).origin;
        } catch {
          redirectOrigin = '';
        }
        if (redirectOrigin && redirectOrigin !== origin) {
          return ctx.json({
            status: 'unavailable_here',
            detail:
              `Connexion ${app.name} indisponible depuis ${origin} : ce client Google n'autorise la ` +
              `redirection que vers ${redirectUri} — ouvrez le site de production et relancez « Connecter » ` +
              `depuis le sélecteur @.`,
            env: [],
          });
        }
      }

      const state = `${uuid()}.${ctx.user!.id}.${app.id}`;

      const params = new URLSearchParams({
        client_id: creds.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        state,
      });
      const scopeName = creds.scopeParam ?? 'scope';
      params.set(scopeName, app.permissions.join(' '));
      if (provider === 'google') {
        params.set('access_type', 'offline');
        params.set('prompt', 'consent');
      }
      for (const [k, v] of Object.entries(creds.extraAuthorizeParams ?? {})) params.set(k, v);

      const url = `${creds.authorizeUrl}?${params.toString()}`;
      const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
      headers.append('set-cookie', stateCookie(state, 600));
      return new Response(JSON.stringify({ status: 'redirect', url }), { status: 200, headers });
    },
  },

  // ------------------- GET /:id/callback (OAuth round-trip) -------------------
  {
    method: 'GET',
    path: ':id/callback',
    auth: 'user',
    handler: async (ctx) => {
      const app = getAppById(ctx.params.id);
      if (!app) err(404, 'Connector not found');
      const provider = app.oauthProvider!;
      const creds = providerCredentials(provider);
      if (!creds) err(400, 'Connexion non configurée');

      const code = ctx.query.get('code');
      const state = ctx.query.get('state') ?? '';
      const expected = cookieValue(ctx.req, 'connector_oauth_state');
      if (!code || !state || !expected || state !== expected) {
        err(400, 'État OAuth invalide ou expiré — relancez la connexion.');
      }
      const [, userId, connectorId] = state.split('.');
      if (userId !== ctx.user!.id || connectorId !== app.id) {
        err(403, 'Cette connexion a été initiée par un autre compte.');
      }

      // Token exchange (standard code flow — same mechanics the login OAuth
      // callback runs, scoped to the connector's permissions). The
      // redirect_uri MUST equal the authorize request's — the same helper
      // builds it (Google: its authorized root, forwarded from "/").
      const origin = requestOrigin(ctx.req);
      const redirectUri = connectorRedirectUri(provider, origin, app.id);
      const tokenBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      });
      if (creds.tokenAuth !== 'basic') {
        tokenBody.set('client_id', creds.clientId);
        tokenBody.set('client_secret', creds.clientSecret);
      }
      const tokenRes = await fetch(creds.tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          ...(creds.tokenAuth === 'basic'
            ? { authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}` }
            : {}),
        },
        body: tokenBody.toString(),
        signal: AbortSignal.timeout(20_000),
      });
      if (!tokenRes.ok) err(502, `Le fournisseur a refusé l'échange de code (HTTP ${tokenRes.status}).`);
      const tokenJson: any = await tokenRes.json().catch(() => null);
      const accessToken =
        tokenJson?.access_token ??
        tokenJson?.authed_user?.access_token ?? // Slack user token
        tokenJson?.bot?.access_token;
      if (!accessToken) err(502, 'Réponse du fournisseur sans jeton.');

      // Account label — best effort (non-blocking).
      let account: string | null = null;
      try {
        account = await fetchAccountLabel(provider, accessToken);
      } catch {
        account = null;
      }

      const now = nowNs();
      const scopes = Array.isArray(tokenJson?.scope) ? tokenJson.scope : String(tokenJson?.scope ?? '');
      // PERSIST THE TOKENS — the connect flow's whole point: tool execution
      // (lib/connectors/google.ts) reads them back from this row to call the
      // provider's API AS THE USER. Google is asked access_type=offline&
      // prompt=consent so refresh_token is always granted; providers that
      // don't issue one (GitHub) keep a short-lived access token only.
      // A re-authorization that omits the refresh token (Google edge case)
      // PRESERVES the previously stored one instead of wiping it.
      const existing = (await db.connectorConnection.findFirst({
        where: { user_id: userId, connector_id: app.id },
      })) as unknown as ConnectionRow | null;
      const refreshToken =
        (typeof tokenJson?.refresh_token === 'string' && tokenJson.refresh_token) ||
        (existing as any)?.refresh_token ||
        null;
      const expiresIn = Number(tokenJson?.expires_in);
      const data: Record<string, unknown> = {
        status: 'connected',
        provider,
        account,
        scopes: JSON.stringify(scopes),
        updated_at: now,
      };
      if (accessToken) data.access_token = accessToken;
      if (refreshToken) data.refresh_token = refreshToken;
      if (Number.isFinite(expiresIn) && expiresIn > 0) {
        data.token_expires_at = Date.now() + expiresIn * 1000;
      }
      if (existing) {
        await db.connectorConnection.update({ where: { id: existing.id }, data });
      } else {
        await db.connectorConnection.create({
          data: { id: uuid(), user_id: userId, connector_id: app.id, created_at: now, ...data },
        });
      }

      // Back to the app — the picker re-fetches the registry and shows the
      // real "connected" state.
      const headers = new Headers({ location: `/?connected=${encodeURIComponent(app.id)}`, 'cache-control': 'no-store' });
      headers.append(
        'set-cookie',
        stateCookie('', 0)
      );
      return new Response(null, { status: 307, headers });
    },
  },

  // ------------------- DELETE /:id (disconnect) -------------------
  {
    method: 'DELETE',
    path: ':id',
    auth: 'user',
    handler: async (ctx) => {
      const app = getAppById(ctx.params.id);
      if (!app) err(404, 'Connector not found');
      if (app.builtin) err(400, 'Ce connecteur est intégré — il ne peut pas être déconnecté.');
      await db.connectorConnection.deleteMany({
        where: { user_id: ctx.user!.id, connector_id: app.id },
      });
      const byConnector = await connectionsFor(ctx.user!.id);
      return ctx.json(listItem(app, byConnector.get(app.id)));
    },
  },
];

/** Best-effort account label for the connected row (never blocks connect). */
async function fetchAccountLabel(provider: string, accessToken: string): Promise<string | null> {
  const get = async (url: string) => {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  };
  if (provider === 'google') {
    const profile = await get('https://openidconnect.googleapis.com/v1/userinfo');
    return profile?.email ?? null;
  }
  if (provider === 'microsoft') {
    const profile = await get('https://graph.microsoft.com/v1.0/me');
    return profile?.userPrincipalName ?? profile?.mail ?? null;
  }
  if (provider === 'github') {
    const profile = await get('https://api.github.com/user');
    return profile?.login ?? profile?.email ?? null;
  }
  if (provider === 'slack') {
    const profile = await get('https://slack.com/api/users.identity');
    return profile?.user?.name ?? null;
  }
  if (provider === 'notion') {
    // Notion: the token response itself carries the owner (no userinfo call).
    return null;
  }
  return null;
}
