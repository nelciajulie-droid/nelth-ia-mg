import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { configGet } from '@/lib/config';
import { DEFAULT_USER_PERMISSIONS, ERROR_MESSAGES } from '@/lib/constants';
import { fillMissingPermissions } from '@/lib/access-control';
import { getTools, getAccessibleResourceIds, safeParse, nowSec, uuid, EM } from '@/lib/models/workspace';

/**
 * Port of open_webui/routers/groups.py (/api/v1/groups).
 * Session invalidation (refresh_group_sessions) is a no-op — no socket runtime.
 */

const DEFAULT_GROUP_SHARE_PERMISSION = (() => {
  const value = (process.env.DEFAULT_GROUP_SHARE_PERMISSION ?? 'members').trim().toLowerCase();
  return value === 'members' ? 'members' : value === 'true';
})();

function err(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

function requireUser(ctx: Ctx) {
  const user = ctx.user;
  if (!user) err(401, ERROR_MESSAGES.NOT_AUTHENTICATED);
  return user;
}

type GroupRow = {
  id: string;
  parent_group_id: string | null;
  user_id: string | null;
  name: string | null;
  description: string | null;
  data: string | null;
  meta: string | null;
  permissions: string | null;
  created_at: number | null;
  updated_at: number | null;
};

type GroupModel = {
  parent_group_id: string | null;
  id: string;
  user_id: string;
  name: string;
  description: string;
  data: Record<string, any> | null;
  meta: Record<string, any> | null;
  permissions: Record<string, any> | null;
  created_at: number;
  updated_at: number;
};

class GroupHierarchyError extends Error {
  constructor(message: string, public statusCode: number = 400) {
    super(message);
  }
}

function rowToModel(row: GroupRow): GroupModel {
  return {
    parent_group_id: row.parent_group_id ?? null,
    id: row.id,
    user_id: row.user_id ?? '',
    name: row.name ?? '',
    description: row.description ?? '',
    data: safeParse<Record<string, any> | null>(row.data, null),
    meta: safeParse<Record<string, any> | null>(row.meta, null),
    permissions: safeParse<Record<string, any> | null>(row.permissions, null),
    created_at: row.created_at ?? 0,
    updated_at: row.updated_at ?? 0,
  };
}

function groupResponse(group: GroupModel, memberCount: number | null = null) {
  return { ...group, member_count: memberCount };
}

// ---------------------------------------------------------------------------
// Hierarchy helpers (models/groups.py)
// ---------------------------------------------------------------------------

function groupDefaultModels(group: GroupModel): string[] | null {
  return (group.data ?? {})['config']?.['default_models'] ?? null;
}

function resolveGroupDefaultModels(groups: GroupModel[]): [string[] | null, string | null] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const depths: Record<string, number> = {};
  for (const group of groups) {
    const path: string[] = [];
    const seen = new Set<string>();
    let current: GroupModel | undefined = group;
    while (current && !(current.id in depths) && !seen.has(current.id)) {
      seen.add(current.id);
      path.push(current.id);
      current = current.parent_group_id ? byId.get(current.parent_group_id) : undefined;
    }
    let depth = current ? (depths[current.id] ?? -1) : -1;
    for (const gid of [...path].reverse()) {
      depth += 1;
      depths[gid] = depth;
    }
  }
  const configured = groups.filter((g) => groupDefaultModels(g));
  if (!configured.length) return [null, null];
  const winner = configured.reduce((best, g) => {
    const key = (c: GroupModel) => [-depths[c.id], c.created_at, c.id];
    const kb = key(best);
    const kg = key(g);
    return kg < kb ? g : best;
  });
  return [groupDefaultModels(winner), winner.id];
}

function combinePermissions(permissions: Record<string, any>, groupPermissions: Record<string, any>): Record<string, any> {
  for (const [key, value] of Object.entries(groupPermissions)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof permissions[key] !== 'object' || permissions[key] === null) permissions[key] = {};
      permissions[key] = combinePermissions(permissions[key], value);
    } else {
      permissions[key] = key in permissions ? permissions[key] || value : value;
    }
  }
  return permissions;
}

/** All group ids the given user belongs to (direct + inherited parents). */
async function userGroupIds(userId: string): Promise<string[]> {
  const memberships = await db.groupMember.findMany({ where: { user_id: userId } });
  const ids = new Set(memberships.map((m) => m.group_id));
  const allGroups = await db.group.findMany({ select: { id: true, parent_group_id: true } });
  const byId = new Map(allGroups.map((g) => [g.id, g]));
  const queue = [...ids];
  const seen = new Set<string>();
  while (queue.length) {
    const gid = queue.pop() as string;
    if (seen.has(gid)) continue;
    seen.add(gid);
    const group = byId.get(gid);
    if (group?.parent_group_id && !ids.has(group.parent_group_id)) {
      ids.add(group.parent_group_id);
      queue.push(group.parent_group_id);
    }
  }
  return [...ids];
}

/** Ancestors of a group (self included). */
async function ancestorGroupIds(groupId: string): Promise<string[]> {
  const allGroups = await db.group.findMany({ select: { id: true, parent_group_id: true } });
  const byId = new Map(allGroups.map((g) => [g.id, g]));
  const out = new Set<string>([groupId]);
  let current = byId.get(groupId);
  const guard = new Set<string>([groupId]);
  while (current?.parent_group_id && !guard.has(current.parent_group_id)) {
    guard.add(current.parent_group_id);
    out.add(current.parent_group_id);
    current = byId.get(current.parent_group_id);
  }
  return [...out];
}

/** The group + all descendants. */
async function descendantGroupIds(groupId: string): Promise<string[]> {
  const allGroups = await db.group.findMany({ select: { id: true, parent_group_id: true } });
  const children = new Map<string, string[]>();
  for (const g of allGroups) {
    if (g.parent_group_id) {
      const list = children.get(g.parent_group_id) ?? [];
      list.push(g.id);
      children.set(g.parent_group_id, list);
    }
  }
  const out: string[] = [groupId];
  const queue = [groupId];
  while (queue.length) {
    const current = queue.pop() as string;
    for (const child of children.get(current) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** Effective member user ids of a group (descendants included). */
async function groupUserIds(groupId: string, includeInherited = false): Promise<string[]> {
  if (!includeInherited) {
    const memberships = await db.groupMember.findMany({ where: { group_id: groupId } });
    return memberships.map((m) => m.user_id);
  }
  const ids = await descendantGroupIds(groupId);
  const memberships = await db.groupMember.findMany({ where: { group_id: { in: ids } } });
  return [...new Set(memberships.map((m) => m.user_id))];
}

async function getGroupById(id: string): Promise<GroupModel | null> {
  const row = await db.group.findUnique({ where: { id } });
  return row ? rowToModel(row as GroupRow) : null;
}

async function getGroupMemberCount(groupId: string): Promise<number> {
  return groupUserIds(groupId, true).then((ids) => ids.length);
}

async function validateParent(groupId: string | null, parentId: string | null | undefined): Promise<void> {
  if (parentId === null || parentId === undefined) return;
  if (!parentId) throw new GroupHierarchyError('Parent group must be a group ID or null.');
  const parent = await db.group.findUnique({ where: { id: parentId } });
  if (!parent) throw new GroupHierarchyError('Parent group not found.', 404);
  const ancestors = await ancestorGroupIds(parentId);
  if (groupId && ancestors.includes(groupId)) {
    throw new GroupHierarchyError('A group cannot be its own parent or a descendant of itself.');
  }
}

function ensureDefaultShareConfig(data: Record<string, any> | null | undefined): Record<string, any> {
  const d = data && typeof data === 'object' ? data : {};
  const config = d['config'] && typeof d['config'] === 'object' ? d['config'] : {};
  if (!('share' in config)) {
    return { ...d, config: { ...config, share: DEFAULT_GROUP_SHARE_PERMISSION } };
  }
  return { ...d, config };
}

/** Python GroupForm data validation for default_models. */
function validateGroupFormData(data: Record<string, any> | null | undefined): Record<string, any> | null {
  if (data === null || data === undefined) return data ?? null;
  if (!('config' in data)) return data;
  const config = data['config'];
  if (!config || typeof config !== 'object') {
    throw new HttpError(400, 'Group config must be an object.');
  }
  if (!('default_models' in config) || config['default_models'] === null) return data;
  const models = config['default_models'];
  if (
    !Array.isArray(models) ||
    models.some((m) => typeof m !== 'string' || !m.trim())
  ) {
    throw new HttpError(400, 'Default models must be a list of non-empty model IDs.');
  }
  return { ...data, config: { ...config, default_models: [...new Set(models.map((m) => m.trim()))] } };
}

function groupHierarchyHttp(e: GroupHierarchyError): never {
  err(e.statusCode, e.message);
}

export const routes: Route[] = [
  // GET / — groups visible to the caller
  {
    method: 'GET',
    path: '',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const shareRaw = ctx.query.get('share');
      const share = shareRaw === null ? null : ['true', '1'].includes(shareRaw.toLowerCase());

      const rows = await db.group.findMany({ orderBy: { updated_at: 'desc' } });
      let groups = rows.map(rowToModel);

      if (user.role !== 'admin') {
        const memberIds = new Set(await userGroupIds(user.id));
        groups = groups.filter((group) => {
          if (!memberIds.has(group.id)) return false;
          if (share === null) return true;
          const shareValue = String((group.data ?? {})['config']?.['share'] ?? '').toLowerCase();
          if (share) {
            return shareValue === 'true' || shareValue === '1' || shareValue === '' || !(group.data ?? {})['config'];
          }
          return (group.data ?? {})['config'] !== undefined && shareValue === 'false';
        });
      } else if (share !== null) {
        groups = groups.filter((group) => {
          const shareValue = String((group.data ?? {})['config']?.['share'] ?? '').toLowerCase();
          if (share) return shareValue === 'true' || shareValue === '1' || !(group.data ?? {})['config'];
          return (group.data ?? {})['config'] !== undefined && shareValue === 'false';
        });
      }

      const out: any[] = [];
      for (const group of groups) {
        out.push(groupResponse(group, await getGroupMemberCount(group.id)));
      }
      return ctx.json(out);
    },
  },

  // POST /create (admin)
  {
    method: 'POST',
    path: 'create',
    auth: 'admin',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const form = await ctx.body<{
        parent_group_id?: string | null;
        name?: string;
        description?: string;
        permissions?: Record<string, any> | null;
        data?: Record<string, any> | null;
      }>();
      try {
        const data = validateGroupFormData(form.data ?? null);
        await validateParent(null, form.parent_group_id ?? null);
        const now = nowSec();
        const groupData = ensureDefaultShareConfig(data);
        const row = await db.group.create({
          data: {
            id: uuid(),
            parent_group_id: form.parent_group_id ?? null,
            user_id: user.id,
            name: String(form.name ?? ''),
            description: String(form.description ?? ''),
            data: JSON.stringify(groupData),
            meta: JSON.stringify({}),
            permissions: form.permissions ? JSON.stringify(form.permissions) : null,
            created_at: now,
            updated_at: now,
          },
        });
        const group = rowToModel(row as GroupRow);
        return ctx.json(groupResponse(group, await getGroupMemberCount(group.id)));
      } catch (e) {
        if (e instanceof GroupHierarchyError) groupHierarchyHttp(e);
        if (e instanceof HttpError) throw e;
        console.error(`Error creating a new group: ${e}`);
        err(400, EM.DEFAULT(e, 'Error creating group'));
      }
    },
  },

  // GET /id/:id (admin)
  {
    method: 'GET',
    path: 'id/:id',
    auth: 'admin',
    handler: async (ctx) => {
      const group = await getGroupById(ctx.params.id);
      if (group) return ctx.json(groupResponse(group, await getGroupMemberCount(group.id)));
      err(404, ERROR_MESSAGES.NOT_FOUND);
    },
  },

  // GET /id/:id/info (verified user)
  {
    method: 'GET',
    path: 'id/:id/info',
    auth: 'user',
    handler: async (ctx) => {
      const group = await getGroupById(ctx.params.id);
      if (group) {
        const memberCount = await getGroupMemberCount(group.id);
        return ctx.json({
          parent_group_id: group.parent_group_id,
          id: group.id,
          user_id: group.user_id,
          name: group.name,
          description: group.description,
          member_count: memberCount,
          created_at: group.created_at,
          updated_at: group.updated_at,
        });
      }
      err(404, ERROR_MESSAGES.NOT_FOUND);
    },
  },

  // GET /id/:id/export (admin)
  {
    method: 'GET',
    path: 'id/:id/export',
    auth: 'admin',
    handler: async (ctx) => {
      const group = await getGroupById(ctx.params.id);
      if (group) {
        return ctx.json({
          ...groupResponse(group, await getGroupMemberCount(group.id)),
          user_ids: await groupUserIds(group.id),
        });
      }
      err(404, ERROR_MESSAGES.NOT_FOUND);
    },
  },

  // POST /id/:id/users (admin) — group members
  {
    method: 'POST',
    path: 'id/:id/users',
    auth: 'admin',
    handler: async (ctx) => {
      const id = ctx.params.id;
      try {
        const memberships = await db.groupMember.findMany({ where: { group_id: id } });
        const users = await db.user.findMany({ where: { id: { in: memberships.map((m) => m.user_id) } } });
        return ctx.json(
          users.map((u) => ({
            id: u.id,
            name: u.name,
            email: u.email ?? '',
            role: u.role ?? 'pending',
            bio: u.bio ?? null,
            last_active_at: u.last_active_at ?? null,
            timezone: u.timezone ?? null,
            status_emoji: u.status_emoji ?? null,
            status_message: u.status_message ?? null,
            status_expires_at: u.status_expires_at ?? null,
            groups: [],
            is_active: false,
          }))
        );
      } catch (e) {
        console.error(`Error getting users in group ${id}: ${e}`);
        err(400, EM.DEFAULT(e, 'Error getting group members'));
      }
    },
  },

  // POST /id/:id/update (admin)
  {
    method: 'POST',
    path: 'id/:id/update',
    auth: 'admin',
    handler: async (ctx) => {
      const id = ctx.params.id;
      const form = await ctx.body<{
        parent_group_id?: string | null;
        name?: string;
        description?: string;
        permissions?: Record<string, any> | null;
        data?: Record<string, any> | null;
      }>();
      try {
        const existing = await db.group.findUnique({ where: { id } });
        if (!existing) throw new GroupHierarchyError('Group not found.', 404);

        await validateParent(id, form.parent_group_id ?? null);

        const values: Record<string, any> = {};
        if (form.parent_group_id !== null && form.parent_group_id !== undefined) {
          values.parent_group_id = form.parent_group_id;
        }
        if (form.name !== null && form.name !== undefined) values.name = form.name;
        if (form.description !== null && form.description !== undefined) values.description = form.description;
        if (form.permissions !== null && form.permissions !== undefined) {
          values.permissions = JSON.stringify(form.permissions);
        }
        if (form.data !== null && form.data !== undefined) {
          const validated = validateGroupFormData(form.data);
          const oldData = safeParse<Record<string, any> | null>(existing.data, null) ?? {};
          const newData = validated ?? {};
          values.data = JSON.stringify({
            ...oldData,
            ...newData,
            config: { ...(oldData['config'] ?? {}), ...(newData['config'] ?? {}) },
          });
        }
        values.updated_at = nowSec();

        await db.group.update({ where: { id }, data: values });
        const group = await getGroupById(id);
        if (group) {
          return ctx.json(groupResponse(group, await getGroupMemberCount(group.id)));
        }
        err(400, EM.DEFAULT('Error updating group'));
      } catch (e) {
        if (e instanceof GroupHierarchyError) groupHierarchyHttp(e);
        if (e instanceof HttpError) throw e;
        console.error(`Error updating group ${id}: ${e}`);
        err(400, EM.DEFAULT(e, 'Error updating group'));
      }
    },
  },

  // POST /id/:id/users/add (admin)
  {
    method: 'POST',
    path: 'id/:id/users/add',
    auth: 'admin',
    handler: async (ctx) => {
      const id = ctx.params.id;
      const form = await ctx.body<{ user_ids?: string[] | null }>();
      try {
        const group = await db.group.findUnique({ where: { id } });
        if (!group) throw new GroupHierarchyError('Group not found.', 404);

        let userIds = form.user_ids ?? [];
        if (userIds.length) {
          const valid = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true } });
          userIds = valid.map((u) => u.id);
        }

        const previous = new Set(
          (await db.groupMember.findMany({ where: { group_id: id } })).map((m) => m.user_id)
        );
        const now = nowSec();
        for (const uid of userIds) {
          if (previous.has(uid)) continue;
          await db.groupMember.create({
            data: { id: uuid(), group_id: id, user_id: uid, created_at: now, updated_at: now },
          });
        }
        await db.group.update({ where: { id }, data: { updated_at: now } });

        const updated = await getGroupById(id);
        if (updated) {
          return ctx.json(groupResponse(updated, await getGroupMemberCount(id)));
        }
        err(400, EM.DEFAULT('Error adding users to group'));
      } catch (e) {
        if (e instanceof GroupHierarchyError) groupHierarchyHttp(e);
        if (e instanceof HttpError) throw e;
        console.error(`Error adding users to group ${id}: ${e}`);
        err(400, EM.DEFAULT(e, 'Error adding users to group'));
      }
    },
  },

  // POST /id/:id/users/remove (admin)
  {
    method: 'POST',
    path: 'id/:id/users/remove',
    auth: 'admin',
    handler: async (ctx) => {
      const id = ctx.params.id;
      const form = await ctx.body<{ user_ids?: string[] | null }>();
      try {
        const group = await db.group.findUnique({ where: { id } });
        if (!group) throw new GroupHierarchyError('Group not found.', 404);

        const userIds = form.user_ids ?? [];
        if (userIds.length) {
          await db.groupMember.deleteMany({ where: { group_id: id, user_id: { in: userIds } } });
        }
        await db.group.update({ where: { id }, data: { updated_at: nowSec() } });

        const updated = await getGroupById(id);
        if (updated) {
          return ctx.json(groupResponse(updated, await getGroupMemberCount(id)));
        }
        err(400, EM.DEFAULT('Error removing users from group'));
      } catch (e) {
        if (e instanceof GroupHierarchyError) groupHierarchyHttp(e);
        if (e instanceof HttpError) throw e;
        console.error(`Error removing users from group ${id}: ${e}`);
        err(400, EM.DEFAULT(e, 'Error removing users from group'));
      }
    },
  },

  // DELETE /id/:id/delete (admin)
  {
    method: 'DELETE',
    path: 'id/:id/delete',
    auth: 'admin',
    handler: async (ctx) => {
      const id = ctx.params.id;
      try {
        const group = await db.group.findUnique({ where: { id } });
        if (!group) throw new GroupHierarchyError('Group not found.', 404);

        const now = nowSec();
        // Promote children to the deleted group's parent.
        await db.group.updateMany({
          where: { parent_group_id: id },
          data: { parent_group_id: group.parent_group_id ?? null, updated_at: now },
        });
        await db.groupMember.deleteMany({ where: { group_id: id } });
        await db.accessGrant.deleteMany({ where: { principal_type: 'group', principal_id: id } });
        await db.group.delete({ where: { id } });
        return ctx.json(true);
      } catch (e) {
        if (e instanceof GroupHierarchyError) groupHierarchyHttp(e);
        if (e instanceof HttpError) throw e;
        console.error(`Error deleting group ${id}: ${e}`);
        err(400, EM.DEFAULT(e, 'Error deleting group'));
      }
    },
  },

  // GET /id/:id/preview (admin) — audit of what a group can access
  {
    method: 'GET',
    path: 'id/:id/preview',
    auth: 'admin',
    handler: async (ctx) => {
      const id = ctx.params.id;
      const group = await getGroupById(id);
      if (!group) err(404, ERROR_MESSAGES.NOT_FOUND);

      const groupIds = await ancestorGroupIds(group.id);

      const modelRows = await db.model.findMany();
      const knowledgeRows = await db.knowledge.findMany();
      const toolRows = await getTools({ deferContent: true });

      const accessibleModelIds = await getAccessibleResourceIds(
        '',
        'model',
        modelRows.map((m) => m.id),
        'read',
        groupIds
      );
      const accessibleKnowledgeIds = await getAccessibleResourceIds(
        '',
        'knowledge',
        knowledgeRows.map((k) => k.id),
        'read',
        groupIds
      );
      const accessibleToolIds = await getAccessibleResourceIds(
        '',
        'tool',
        toolRows.map((t) => t.id),
        'read',
        groupIds
      );

      const activeModels = modelRows.filter((m) => m.is_active !== false);

      const ancestors = (
        await db.group.findMany({ where: { id: { in: groupIds.filter((gid) => gid !== id) } } })
      ).map(rowToModel);

      const userPermissions = await configGet<Record<string, any> | null>('user.permissions', null);
      let inheritedPermissions = fillMissingPermissions(
        structuredClone(userPermissions ?? {}),
        DEFAULT_USER_PERMISSIONS
      );
      for (const ancestor of ancestors) {
        inheritedPermissions = combinePermissions(inheritedPermissions, ancestor.permissions ?? {});
      }
      const effectivePermissions = combinePermissions(
        structuredClone(inheritedPermissions),
        group.permissions ?? {}
      );

      let [defaultModels, sourceGroupId] = resolveGroupDefaultModels([group, ...ancestors]);
      if (defaultModels === null) {
        const raw = await configGet<string>('ui.default_models', '');
        defaultModels = String(raw ?? '')
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean);
      }

      return ctx.json({
        group: { id: group.id, name: group.name },
        default_models: {
          local: groupDefaultModels(group),
          effective: defaultModels,
          source_group_id: sourceGroupId,
        },
        models: {
          items: activeModels
            .filter((m) => accessibleModelIds.has(m.id))
            .map((m) => ({ id: m.id, name: m.name ?? m.id })),
          total: activeModels.length,
        },
        knowledge: {
          items: knowledgeRows
            .filter((k) => accessibleKnowledgeIds.has(k.id))
            .map((k) => ({ id: k.id, name: k.name ?? k.id })),
          total: knowledgeRows.length,
        },
        tools: {
          items: toolRows
            .filter((t) => accessibleToolIds.has(t.id))
            .map((t) => ({ id: t.id, name: t.name })),
          total: toolRows.length,
        },
        permissions: group.permissions ?? {},
        inherited_permissions: inheritedPermissions,
        effective_permissions: effectivePermissions,
      });
    },
  },

  // GET /id/:id/members (admin)
  {
    method: 'GET',
    path: 'id/:id/members',
    auth: 'admin',
    handler: async (ctx) => {
      const id = ctx.params.id;
      const membership = (ctx.query.get('membership') ?? 'effective') as 'direct' | 'inherited' | 'effective';
      const query = ctx.query.get('query') ?? '';
      const page = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);

      const group = await db.group.findUnique({ where: { id } });
      if (!group) err(404, 'Group not found.');

      const directRows = await db.groupMember.findMany({ where: { group_id: id } });
      const directIds = new Set(directRows.map((m) => m.user_id));
      const effectiveIds = new Set(await groupUserIds(id, true));

      let candidateIds = [...effectiveIds];
      if (membership === 'direct') candidateIds = [...directIds];
      else if (membership === 'inherited') candidateIds = [...effectiveIds].filter((uid) => !directIds.has(uid));

      const descendantIds = new Set(await descendantGroupIds(id));
      const allMemberships = await db.groupMember.findMany({
        where: { group_id: { in: [...descendantIds] } },
      });
      const sources = new Map<string, string[]>();
      for (const uid of effectiveIds) sources.set(uid, []);
      for (const m of allMemberships) {
        if (!sources.has(m.user_id)) continue;
        sources.get(m.user_id)!.push(m.group_id);
      }

      let users = await db.user.findMany({ where: { id: { in: candidateIds } } });
      if (query) {
        const q = query.toLowerCase();
        users = users.filter(
          (u) => (u.name ?? '').toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q)
        );
      }
      users.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.id.localeCompare(b.id));

      const total = users.length;
      const pageUsers = users.slice((page - 1) * 30, page * 30);

      return ctx.json({
        items: pageUsers.map((u) => {
          const via = sources.get(u.id) ?? [];
          return {
            id: u.id,
            name: u.name,
            email: u.email ?? '',
            role: u.role ?? 'pending',
            status_emoji: u.status_emoji ?? null,
            status_message: u.status_message ?? null,
            status_expires_at: u.status_expires_at ?? null,
            bio: u.bio ?? null,
            last_active_at: u.last_active_at ?? null,
            timezone: u.timezone ?? null,
            groups: [],
            is_active: false,
            membership_type: via.includes(id) ? 'direct' : 'inherited',
            via_group_ids: [...new Set(via.filter((gid) => gid !== id))].sort(),
          };
        }),
        total,
        counts: {
          direct: directIds.size,
          effective: effectiveIds.size,
          inherited: effectiveIds.size - directIds.size,
        },
      });
    },
  },
];
