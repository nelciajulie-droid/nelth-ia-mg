import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { env } from '@/lib/constants';
import { configGet } from '@/lib/config';
import { hasAccessGrant } from '@/lib/access-control';
import { nowNs, uuid, setAccessGrants, getGrantsByResource, EM } from '@/lib/models/workspace';

/**
 * Port of open_webui/routers/apps.py (v0.12.5) — /api/v1/apps/*.
 *
 * Gate: `apps.enable` (env ENABLE_APPS, default False) → 404 'Apps are disabled'.
 *
 * Deviations (documented):
 *   • The app api_key is stored base64-encoded rather than Fernet-encrypted
 *     (no Python cryptography runtime); it is never returned in responses.
 *   • Socket-based connection management (connections.connect/status) is not
 *     available — connection_status is always 'disconnected' and connecting
 *     does not flip is_active.
 *   • App interactions (channel action invocations) are not ported — after
 *     the validation gates they return 503.
 */

function err(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

function safeJson(s: string | null | undefined): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function appsEnabled(): Promise<boolean> {
  return configGet<boolean>('apps.enable', env.ENABLE_APPS);
}

type AppRow = {
  id: string;
  slug: string;
  name: string;
  user_id: string | null;
  is_active: boolean;
  data: string;
  api_key: string | null;
  created_at: number;
  updated_at: number;
};

function getAppResponse(app: AppRow): Record<string, any> {
  const data = safeJson(app.data) ?? {};
  delete data.connection_token;
  delete data.webui_url;
  return {
    connection_status: 'disconnected',
    id: app.id,
    slug: app.slug,
    name: app.name,
    is_active: app.is_active,
    configured: Boolean(app.api_key),
    data,
    created_at: app.created_at,
    updated_at: app.updated_at,
  };
}

async function getAppById(
  appId: string,
  opts: { requireActive?: boolean } = {}
): Promise<AppRow | null> {
  if (!(await appsEnabled())) err(404, 'Apps are disabled');
  const app = (await db.app.findFirst({ where: { id: appId } })) as AppRow | null;
  if (!app) err(404, 'App not found');
  if (opts.requireActive) {
    const data = safeJson(app!.data) ?? {};
    if (!app!.is_active || !data.manifest?.public_key || !app!.api_key) {
      err(403, 'App is inactive');
    }
  }
  return app;
}

async function hasAppAccess(app: AppRow, userId: string): Promise<boolean> {
  return hasAccessGrant(userId, 'app', app.id, 'read');
}

/** Python validate_app_url — HTTPS required (private-origin allowlist env). */
function validateAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.search) throw new Error('App URL must not contain a query');
    const privateOrigins = (process.env.APP_ALLOWED_PRIVATE_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    const allowed = privateOrigins.includes(parsed.origin);
    if (parsed.protocol !== 'https:' && !(allowed && parsed.protocol === 'http:')) {
      throw new Error('App endpoints require HTTPS');
    }
    return allowed;
  } catch {
    throw new Error('Invalid app URL');
  }
}

export const routes: Route[] = [
  // ------------------- GET / (list apps) -------------------
  {
    method: 'GET',
    path: '',
    auth: 'user',
    handler: async (ctx) => {
      if (!(await appsEnabled())) err(404, 'Apps are disabled');
      const user = ctx.user!;
      const apps = (await db.app.findMany({ orderBy: { name: 'asc' } })) as AppRow[];
      const out: Array<Record<string, any>> = [];
      for (const app of apps) {
        if (user.role === 'admin' || (app.is_active && (await hasAppAccess(app, user.id)))) {
          out.push(getAppResponse(app));
        }
      }
      return ctx.json(out);
    },
  },

  // ------------------- POST /manifest/preview (admin) -------------------
  {
    method: 'POST',
    path: 'manifest/preview',
    auth: 'admin',
    handler: async (ctx) => {
      if (!(await appsEnabled())) err(404, 'Apps are disabled');
      const form = await ctx.body<Record<string, any>>();
      if (!form?.url) err(422, 'Field required (url)');
      let apiKey = form?.api_key ?? null;
      if (form?.app_id) {
        const app = (await db.app.findFirst({ where: { id: String(form.app_id) } })) as AppRow | null;
        if (!app) err(404, 'App not found');
        const data = safeJson(app!.data) ?? {};
        if (form.url !== data.url) err(400, 'App URL does not match the installed app');
        if (apiKey === null && app!.api_key) {
          apiKey = Buffer.from(app!.api_key, 'base64').toString('utf-8');
        }
      }
      if (!apiKey) err(400, 'An app API key is required');

      try {
        const res = await fetch(String(form.url), {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 401 || res.status === 403) {
          err(400, 'App rejected the API key. Check the API key configured on the app server.');
        }
        if (res.status !== 200) {
          err(502, `App manifest endpoint returned HTTP ${res.status}. Check the URL or enter details manually.`);
        }
        const raw = await res.json();
        const manifest = raw?.manifest ?? raw;
        if (
          !manifest ||
          typeof manifest !== 'object' ||
          !manifest.id ||
          !manifest.name ||
          !manifest.public_key ||
          !Array.isArray(manifest.requested_scopes)
        ) {
          err(400, 'App returned an invalid manifest. Check its app details or enter them manually.');
        }
        return ctx.json(manifest);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, 'App returned an invalid manifest. Check its app details or enter them manually.');
      }
    },
  },

  // ------------------- POST / (create app, admin) -------------------
  {
    method: 'POST',
    path: '',
    auth: 'admin',
    handler: async (ctx) => {
      if (!(await appsEnabled())) err(404, 'Apps are disabled');
      const form = await ctx.body<Record<string, any>>();
      if (!form?.url || !form?.slug || !form?.manifest || !form?.api_key) {
        err(422, 'Field required');
      }
      try {
        validateAppUrl(String(form.url));
      } catch {
        err(400, 'Invalid app URL');
      }
      const grantedScopes: string[] = Array.isArray(form.granted_scopes) ? form.granted_scopes : [];
      const requestedScopes: string[] = Array.isArray(form.manifest.requested_scopes)
        ? form.manifest.requested_scopes
        : [];
      if (!grantedScopes.every((scope) => requestedScopes.includes(scope))) {
        err(400, 'Unrequested scope');
      }

      const now = nowNs();
      const id = uuid();
      try {
        await db.app.create({
          data: {
            id,
            slug: String(form.slug),
            name: String(form.manifest.name),
            user_id: ctx.user!.id,
            is_active: false,
            data: JSON.stringify({
              url: form.url,
              manifest: form.manifest,
              granted_scopes: grantedScopes,
              settings: {},
            }),
            // Deviation: base64 obfuscation instead of Fernet encryption.
            api_key: Buffer.from(String(form.api_key), 'utf-8').toString('base64'),
            created_at: now,
            updated_at: now,
          },
        });
        await setAccessGrants(
          'app',
          id,
          form.access_grants ?? [{ principal_type: 'user', principal_id: '*', permission: 'read' }]
        );
      } catch (e) {
        if (e instanceof HttpError) throw e;
        if (String(e).includes('Unique constraint')) err(409, 'App slug is already registered');
        throw e;
      }

      const app = (await db.app.findFirst({ where: { id } })) as AppRow | null;
      return ctx.json(getAppResponse(app!));
    },
  },

  // ------------------- GET /{app_id} (admin) -------------------
  {
    method: 'GET',
    path: ':app_id',
    auth: 'admin',
    handler: async (ctx) => {
      const app = await getAppById(ctx.params.app_id);
      const grants = await getGrantsByResource('app', ctx.params.app_id);
      return ctx.json({
        ...getAppResponse(app!),
        access_grants: grants.map((g) => ({
          principal_type: g.principal_type,
          principal_id: g.principal_id,
          permission: g.permission,
        })),
      });
    },
  },

  // ------------------- PATCH /{app_id} (admin) -------------------
  {
    method: 'PATCH',
    path: ':app_id',
    auth: 'admin',
    handler: async (ctx) => {
      const app = await getAppById(ctx.params.app_id);
      if (!app) err(404, 'App not found');
      const form = await ctx.body<Record<string, any>>();
      const data = safeJson(app!.data) ?? {};

      if (form?.is_active === true) err(400, 'Connect the app to enable it');

      const patch: Record<string, any> = {};
      const updatedData: Record<string, any> = { ...data };
      if (form?.is_active === false) patch.is_active = false;
      if (form?.name !== undefined && form?.name !== null) patch.name = String(form.name);
      if (form?.settings !== undefined && form?.settings !== null) {
        updatedData.settings = form.settings;
      }

      if (form?.manifest !== undefined && form?.manifest !== null) {
        if (form.manifest.id !== data.manifest?.id) err(400, 'App identity cannot change');
        const grantedScopes = form.granted_scopes ?? null;
        const requestedScopes: string[] = Array.isArray(form.manifest.requested_scopes)
          ? form.manifest.requested_scopes
          : [];
        if (grantedScopes === null || !grantedScopes.every((scope: string) => requestedScopes.includes(scope))) {
          err(400, 'Review the updated scopes');
        }
        updatedData.manifest = form.manifest;
        updatedData.granted_scopes = grantedScopes;
        if (form.manifest.public_key !== data.manifest?.public_key) {
          delete updatedData.connection_token;
          delete updatedData.installation_id;
        }
        patch.is_active = false;
      } else if (form?.granted_scopes !== undefined && form?.granted_scopes !== null) {
        const requestedScopes: string[] = Array.isArray(data.manifest?.requested_scopes)
          ? data.manifest.requested_scopes
          : [];
        if (!(form.granted_scopes as string[]).every((scope) => requestedScopes.includes(scope))) {
          err(400, 'Unrequested scope');
        }
        updatedData.granted_scopes = form.granted_scopes;
      }

      const now = Math.max(nowNs(), (app!.updated_at ?? 0) + 1);
      patch.data = JSON.stringify(updatedData);
      patch.updated_at = now;
      await db.app.update({ where: { id: app!.id }, data: patch });
      if (form?.access_grants !== undefined && form?.access_grants !== null) {
        await setAccessGrants('app', app!.id, form.access_grants);
      }

      const updated = (await db.app.findFirst({ where: { id: app!.id } })) as AppRow | null;
      return ctx.json(getAppResponse(updated!));
    },
  },

  // ------------------- POST /{app_id}/connect (admin) -------------------
  {
    method: 'POST',
    path: ':app_id/connect',
    auth: 'admin',
    handler: async (ctx) => {
      const app = await getAppById(ctx.params.app_id);
      if (!app) err(404, 'App not found');
      const form = await ctx.body<Record<string, any>>();
      const data = safeJson(app!.data) ?? {};

      if (form?.api_key !== undefined && form?.api_key !== null) {
        const value = String(form.api_key);
        const old = app!.api_key ? Buffer.from(app.api_key, 'base64').toString('utf-8') : null;
        if (value !== old) {
          delete data.connection_token;
          delete data.installation_id;
          await db.app.update({
            where: { id: app!.id },
            data: {
              api_key: Buffer.from(value, 'utf-8').toString('base64'),
              data: JSON.stringify(data),
            },
          });
        }
      }
      const current = (await db.app.findFirst({ where: { id: app!.id } })) as AppRow | null;
      if (!current?.api_key) err(400, 'An app API key is required');

      const now = Math.max(nowNs(), (current!.updated_at ?? 0) + 1);
      await db.app.update({
        where: { id: current!.id },
        data: { is_active: false, updated_at: now },
      });
      const updated = (await db.app.findFirst({ where: { id: app!.id } })) as AppRow | null;
      // No socket runtime: the app stays 'disconnected'.
      return ctx.json({ ...getAppResponse(updated!), connection_status: 'disconnected' });
    },
  },

  // ------------------- DELETE /{app_id} (admin) -------------------
  {
    method: 'DELETE',
    path: ':app_id',
    auth: 'admin',
    handler: async (ctx) => {
      const app = await getAppById(ctx.params.app_id);
      await db.accessGrant.deleteMany({ where: { resource_type: 'app', resource_id: app!.id } });
      await db.app.delete({ where: { id: app!.id } });
      return ctx.json(getAppResponse(app!));
    },
  },

  // ------------------- POST /{app_id}/interactions (user) -------------------
  {
    method: 'POST',
    path: ':app_id/interactions',
    auth: 'user',
    handler: async (ctx) => {
      const app = await getAppById(ctx.params.app_id, { requireActive: true });
      const form = await ctx.body<Record<string, any>>();
      if (!form?.message_id || !form?.action_id) err(422, 'Field required');

      const message = await db.message.findFirst({ where: { id: String(form.message_id) } });
      if (!message || message.app_id !== app!.id) err(404, 'App message not found');

      const data = safeJson(message.data) ?? {};
      const actions = data?.app?.actions ?? [];
      const action = actions.find((item: any) => item?.action_id === form.action_id);
      if (!action) err(400, 'Unknown action');

      // Channel access check (check_app_invocation_access).
      const channel = await db.channel.findFirst({ where: { id: message.channel_id ?? '' } });
      if (!channel || channel.type === 'dm' || channel.deleted_at || channel.archived_at) {
        err(404, 'Channel unavailable');
      }
      const user = ctx.user!;
      if (user.role !== 'admin') {
        if (user.role !== 'user') err(403, 'User is inactive');
        if (channel.type === 'group') {
          const member = await db.channelMember.findFirst({
            where: { channel_id: channel.id, user_id: user.id, is_active: true },
          });
          if (!member) err(403, 'App invocation denied');
        } else {
          const granted = await hasAccessGrant(user.id, 'channel', channel.id, 'read');
          if (!granted) err(403, 'App invocation denied');
        }
      }

      // Deviation: app channel replies require the app runtime + socket.
      err(503, 'App interactions are not available in this deployment.');
    },
  },
];
