import type { Route } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { env } from '@/lib/constants';

/**
 * Port of open_webui/routers/scim.py (1254 lines).
 *
 * Mounting parity: Python only mounts the SCIM router when ENABLE_SCIM=True
 * (default False) — disabled means 404 for every /api/v1/scim/v2 path.
 * When enabled, auth is a Bearer SCIM_TOKEN (not a user JWT).
 */

const SCIM_BASE = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0'],
};

function scimUser(u: {
  id: string;
  email: string | null;
  name: string;
  username: string | null;
  role: string | null;
  last_active_at: number | null;
  created_at: number | null;
  updated_at: number | null;
  active?: boolean | null;
  scim?: string | null;
}) {
  let scimData: any = null;
  try {
    scimData = u.scim ? JSON.parse(u.scim) : null;
  } catch {
    scimData = null;
  }
  return {
    id: u.id,
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    userName: u.username ?? u.email ?? u.id,
    name: {
      formatted: u.name,
    },
    displayName: u.name,
    emails: u.email ? [{ value: u.email, primary: true }] : [],
    active: scimData?.active ?? true,
    meta: {
      resourceType: 'User',
      created: u.created_at ? new Date(u.created_at * 1000).toISOString() : null,
      lastModified: u.updated_at ? new Date(u.updated_at * 1000).toISOString() : null,
    },
    'urn:ietf:params:scim:schemas:extension:openwebui:2.0:User': {
      role: u.role ?? 'pending',
    },
  };
}

function scimEnabled(): boolean {
  return (process.env.ENABLE_SCIM ?? process.env.SCIM_ENABLED ?? 'False').toLowerCase() === 'true';
}

/** Bearer SCIM token auth (not user JWT). */
function scimAuth(req: Request): void {
  if (!scimEnabled()) {
    // Python mounts the router only when enabled → 404
    throw new HttpError(404, 'Not Found');
  }
  const token = process.env.SCIM_TOKEN;
  const header = req.headers.get('authorization') ?? '';
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    throw new HttpError(401, 'Invalid authentication scheme');
  }
  if (!token || token !== parts[1]) {
    throw new HttpError(401, 'Invalid SCIM token');
  }
}

function userFromScimForm(form: any) {
  const emails = form?.emails ?? [];
  const primary = emails.find((e: any) => e?.primary) ?? emails[0];
  const displayName = form?.displayName ?? form?.name?.formatted ?? primary?.value ?? '';
  const email = String(primary?.value ?? '').toLowerCase();
  const ext = form?.['urn:ietf:params:scim:schemas:extension:openwebui:2.0:User'] ?? {};
  const role = ext?.role ?? 'pending';
  return { email, displayName, role, userName: form?.userName };
}

export const routes: Route[] = [
  {
    method: 'GET',
    path: 'v2/ServiceProviderConfig',
    auth: 'none',
    handler: async (ctx) => {
      scimAuth(ctx.req);
      return ctx.json({
        ...SCIM_BASE,
        patch: { supported: false },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: 200 },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
        authenticationSchemes: [{ type: 'oauthbearertoken', name: 'OAuth Bearer Token' }],
      });
    },
  },
  {
    method: 'GET',
    path: 'v2/ResourceTypes',
    auth: 'none',
    handler: async (ctx) => {
      scimAuth(ctx.req);
      return ctx.json([
        {
          id: 'User',
          name: 'User',
          endpoint: '/api/v1/scim/v2/Users',
          schema: 'urn:ietf:params:scim:schemas:core:2.0:User',
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        },
      ]);
    },
  },
  {
    method: 'GET',
    path: 'v2/Schemas',
    auth: 'none',
    handler: async (ctx) => {
      scimAuth(ctx.req);
      return ctx.json({ schemas: [], totalResults: 0 });
    },
  },
  {
    method: 'GET',
    path: 'v2/Users',
    auth: 'none',
    handler: async (ctx) => {
      scimAuth(ctx.req);
      const filter = ctx.query.get('filter');
      const startIndex = Math.max(1, Number(ctx.query.get('startIndex') ?? 1));
      const count = Math.min(200, Number(ctx.query.get('count') ?? 100));
      let users = await db.user.findMany();
      if (filter) {
        // userName eq "..." | emails.value eq "..."
        const m = filter.match(/(\w+(?:\.\w+)*)\s+eq\s+"(.*)"/);
        if (m) {
          const field = m[1];
          const value = m[2].toLowerCase();
          users = users.filter((u) => {
            if (field === 'userName') return (u.username ?? u.email ?? '').toLowerCase() === value;
            if (field === 'emails.value' || field === 'emails') return (u.email ?? '').toLowerCase() === value;
            return false;
          });
        }
      }
      const items = users.slice(startIndex - 1, startIndex - 1 + count);
      return ctx.json({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ListResponse'],
        totalResults: users.length,
        startIndex,
        itemsPerPage: count,
        Resources: items.map(scimUser),
      });
    },
  },
  {
    method: 'GET',
    path: 'v2/Users/:user_id',
    auth: 'none',
    handler: async (ctx) => {
      scimAuth(ctx.req);
      const user = await db.user.findFirst({ where: { id: ctx.params.user_id } });
      if (!user) return ctx.error(404, 'User not found');
      return ctx.json(scimUser(user));
    },
  },
  {
    method: 'POST',
    path: 'v2/Users',
    auth: 'none',
    handler: async (ctx) => {
      scimAuth(ctx.req);
      const form = await ctx.body<any>();
      const { email, displayName, role, userName } = userFromScimForm(form);
      if (!email) return ctx.error(400, 'email is required');
      const existing = await db.user.findFirst({ where: { email } });
      if (existing) return ctx.error(409, 'User already exists');
      const id = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      await db.user.create({
        data: {
          id,
          email,
          name: displayName || email,
          username: userName ?? null,
          role,
          profile_image_url: '/user.png',
          created_at: now,
          updated_at: now,
          scim: JSON.stringify({ active: true, externalId: form?.externalId ?? null }),
        },
      });
      const created = await db.user.findFirst({ where: { id } });
      return ctx.json(scimUser(created!), 201);
    },
  },
  {
    method: 'PUT',
    path: 'v2/Users/:user_id',
    auth: 'none',
    handler: async (ctx) => {
      scimAuth(ctx.req);
      const user = await db.user.findFirst({ where: { id: ctx.params.user_id } });
      if (!user) return ctx.error(404, 'User not found');
      const form = await ctx.body<any>();
      const { email, displayName, role, userName } = userFromScimForm(form);
      const now = Math.floor(Date.now() / 1000);
      await db.user.update({
        where: { id: user.id },
        data: {
          ...(email ? { email } : {}),
          ...(displayName ? { name: displayName } : {}),
          ...(userName !== undefined ? { username: userName } : {}),
          ...(role ? { role } : {}),
          updated_at: now,
        },
      });
      const updated = await db.user.findFirst({ where: { id: user.id } });
      return ctx.json(scimUser(updated!));
    },
  },
  {
    method: 'PATCH',
    path: 'v2/Users/:user_id',
    auth: 'none',
    handler: async (ctx) => {
      scimAuth(ctx.req);
      const user = await db.user.findFirst({ where: { id: ctx.params.user_id } });
      if (!user) return ctx.error(404, 'User not found');
      const form = await ctx.body<any>();
      const now = Math.floor(Date.now() / 1000);
      for (const op of form?.Operations ?? []) {
        if (op?.op === 'replace' && op?.path === 'active') {
          const scim = user.scim ? JSON.parse(user.scim) : {};
          scim.active = Boolean(op.value);
          await db.user.update({
            where: { id: user.id },
            data: { scim: JSON.stringify(scim), updated_at: now },
          });
        }
      }
      const updated = await db.user.findFirst({ where: { id: user.id } });
      return ctx.json(scimUser(updated!));
    },
  },
  {
    method: 'DELETE',
    path: 'v2/Users/:user_id',
    auth: 'none',
    handler: async (ctx) => {
      scimAuth(ctx.req);
      const user = await db.user.findFirst({ where: { id: ctx.params.user_id } });
      if (!user) return ctx.error(404, 'User not found');
      await db.user.delete({ where: { id: user.id } });
      await db.auth.deleteMany({ where: { id: user.id } });
      return new Response(null, { status: 204 });
    },
  },
  {
    method: 'GET',
    path: 'v2/Groups',
    auth: 'none',
    handler: async (ctx) => {
      scimAuth(ctx.req);
      const groups = await db.group.findMany();
      return ctx.json({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ListResponse'],
        totalResults: groups.length,
        startIndex: 1,
        itemsPerPage: groups.length,
        Resources: groups.map((g) => ({
          id: g.id,
          displayName: g.name ?? g.id,
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        })),
      });
    },
  },
  {
    method: 'GET',
    path: 'v2/Groups/:group_id',
    auth: 'none',
    handler: async (ctx) => {
      scimAuth(ctx.req);
      const group = await db.group.findFirst({ where: { id: ctx.params.group_id } });
      if (!group) return ctx.error(404, 'Group not found');
      const members = await db.groupMember.findMany({ where: { group_id: group.id } });
      return ctx.json({
        id: group.id,
        displayName: group.name ?? group.id,
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        members: members.map((m) => ({ value: m.user_id, display: m.user_id })),
      });
    },
  },
];

void env;
