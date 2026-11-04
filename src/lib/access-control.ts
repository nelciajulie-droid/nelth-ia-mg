import { db } from '@/lib/db';
import { DEFAULT_USER_PERMISSIONS } from '@/lib/constants';

/**
 * Port of open_webui/utils/access_control/__init__.py
 * + models/access_grants.py (AccessGrants.has_access).
 */

export type Json = Record<string, any>;

// ---------------------------------------------------------------------------
// Groups helpers
// ---------------------------------------------------------------------------

/** Direct + inherited group ids for a user (walks the parent chain). */
export async function getUserGroupIds(userId: string): Promise<string[]> {
  const memberships = await db.groupMember.findMany({ where: { user_id: userId } });
  const groupIds = new Set<string>(memberships.map((m) => m.group_id));

  // resolve inherited (parent) groups
  const allGroups = await db.group.findMany({
    select: { id: true, parent_group_id: true },
  });
  const byId = new Map(allGroups.map((g) => [g.id, g]));
  const queue = [...groupIds];
  const seen = new Set<string>();
  while (queue.length) {
    const gid = queue.pop() as string;
    if (seen.has(gid)) continue;
    seen.add(gid);
    const g = byId.get(gid);
    if (g?.parent_group_id && !groupIds.has(g.parent_group_id)) {
      groupIds.add(g.parent_group_id);
      queue.push(g.parent_group_id);
    }
  }
  return [...groupIds];
}

export async function getGroupsByMemberId(userId: string): Promise<Array<{ id: string; permissions: Json | null }>> {
  const ids = await getUserGroupIds(userId);
  if (!ids.length) return [];
  const groups = await db.group.findMany({ where: { id: { in: ids } } });
  return groups.map((g) => ({
    id: g.id,
    permissions: g.permissions ? safeJson(g.permissions) : null,
  }));
}

function safeJson(s: string | null): Json | null {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

function deepMergePermissive(base: Json, override: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = k in base && base[k] && typeof base[k] === 'object' ? deepMergePermissive(base[k], v) : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Python: fill_missing_permissions — merge defaults underneath user-provided permissions. */
export function fillMissingPermissions(permissions: Json, defaults: Json = DEFAULT_USER_PERMISSIONS): Json {
  return deepMergePermissive(structuredClone(defaults), permissions || {});
}

/** Python: get_permissions — default permissions combined with group permissions (most permissive wins). */
export async function getPermissions(
  userId: string,
  defaultPermissions: Json | null
): Promise<Json> {
  let permissions = fillMissingPermissions(structuredClone(defaultPermissions || {}));
  const groups = await getGroupsByMemberId(userId);
  for (const group of groups) {
    if (group.permissions) {
      permissions = orMerge(permissions, group.permissions);
    }
  }
  return permissions;
}

/** Boolean OR at every leaf (most permissive value wins). */
function orMerge(a: Json, b: Json): Json {
  const out: Json = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      out[k] = orMerge((typeof a[k] === 'object' && a[k]) || {}, v);
    } else {
      out[k] = Boolean(out[k]) || Boolean(v);
    }
  }
  return out;
}

/** Python: has_permission — hierarchical 'workspace.models' style key check. */
export async function hasPermission(userId: string, permissionKey: string, defaultPermissions: Json | null): Promise<boolean> {
  const traverse = (perms: Json, keys: string[]): boolean => {
    let cur: any = perms;
    for (const key of keys) {
      if (cur === null || typeof cur !== 'object' || !(key in cur)) return false;
      cur = cur[key];
    }
    return Boolean(cur);
  };
  const hierarchy = permissionKey.split('.');
  const groups = await getGroupsByMemberId(userId);
  for (const group of groups) {
    if (group.permissions && traverse(group.permissions, hierarchy)) return true;
  }
  const defaults = fillMissingPermissions(structuredClone(defaultPermissions || {}));
  return traverse(defaults, hierarchy);
}

// ---------------------------------------------------------------------------
// Access grants (DB-table based access control used by v0.12.5)
// ---------------------------------------------------------------------------

/**
 * PUBLIC-APP MODE (chatgpt-like): workspace content types that are public by
 * default when they carry no access grant — everyone sees them in the shared
 * catalog, exactly like the admin account used to. Personal content types
 * (note, folder, channel, calendar, shared_chat…) stay owner-only until they
 * are explicitly shared.
 */
export const PUBLIC_BY_DEFAULT_RESOURCE_TYPES = new Set([
  'model',
  'tool',
  'skill',
  'prompt',
  'knowledge',
]);

/**
 * Python: AccessGrants.has_access(user_id, resource_type, resource_id, permission)
 * Public ('*') grants, direct user grants and group grants all allow access.
 * PUBLIC-APP EXTENSION: a shared-catalog resource (see
 * PUBLIC_BY_DEFAULT_RESOURCE_TYPES) with no grant rows at all is public.
 */
export async function hasAccessGrant(
  userId: string,
  resourceType: string,
  resourceId: string,
  permission: string = 'read',
  userGroupIds?: string[]
): Promise<boolean> {
  const groups = userGroupIds ?? (await getUserGroupIds(userId));
  const grants = await db.accessGrant.findMany({
    where: { resource_type: resourceType, resource_id: resourceId },
  });
  if (!grants.length) {
    return permission === 'read' && PUBLIC_BY_DEFAULT_RESOURCE_TYPES.has(resourceType);
  }
  for (const g of grants) {
    if (g.permission !== permission) continue;
    if (g.principal_type === 'user' && (g.principal_id === '*' || g.principal_id === userId)) return true;
    if (g.principal_type === 'group' && groups.includes(g.principal_id)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Legacy JSON access_control dicts ({read: {group_ids, user_ids}, ...})
// still used by several resources (knowledge, models, folders...)
// ---------------------------------------------------------------------------

export async function hasAccessJson(
  userId: string,
  permission: 'read' | 'write',
  accessControl: Json | null | undefined
): Promise<boolean> {
  if (accessControl === null || accessControl === undefined) return true; // None → public in Python
  if (typeof accessControl === 'string' && accessControl === 'public') return true;
  const entry = accessControl?.[permission];
  if (!entry) return false;
  const groupIds: string[] = entry.group_ids ?? [];
  const userIds: string[] = entry.user_ids ?? [];
  if (groupIds.length === 0 && userIds.length === 0) return true; // empty → public
  if (userIds.includes(userId)) return true;
  if (groupIds.length) {
    const userGroups = await getUserGroupIds(userId);
    if (groupIds.some((g) => userGroups.includes(g))) return true;
  }
  return false;
}
