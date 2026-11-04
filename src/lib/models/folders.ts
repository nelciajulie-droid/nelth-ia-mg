import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { hasAccessGrant } from '@/lib/access-control';

/**
 * Port of open_webui/models/folders.py (FolderTable) — SQLite via Prisma.
 *
 * FolderModel mirrors the Python pydantic model field-for-field:
 *   {id, parent_id, user_id, name, items, meta, data, is_expanded,
 *    created_at, updated_at}
 *
 * Also ports open_webui/utils/access_control/folders.py:
 *   has_folder_access / has_folder_write_access / has_chat_move_access
 * (hasAccessGrant comes from @/lib/access-control — the AccessGrants.has_access port).
 */

export type Json = Record<string, any>;

export type FolderModel = {
  id: string;
  parent_id: string | null;
  user_id: string;
  name: string;
  items: Json | null;
  meta: Json | null;
  data: Json | null;
  is_expanded: boolean;
  created_at: number;
  updated_at: number;
};

export type FolderForm = {
  name: string;
  data?: Json | null;
  meta?: Json | null;
  parent_id?: string | null;
};

export type FolderUpdateForm = {
  name?: string | null;
  data?: Json | null;
  meta?: Json | null;
};

// ---------------------------------------------------------------------------
// Row conversion (JSON columns are TEXT in Prisma)
// ---------------------------------------------------------------------------

type FolderRow = {
  id: string;
  parent_id: string | null;
  user_id: string | null;
  name: string | null;
  items: string | null;
  meta: string | null;
  data: string | null;
  is_expanded: boolean | number | null;
  created_at: number | null;
  updated_at: number | null;
};

function parseJsonObj(s: string | null | undefined): Json | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

export function folderRowToModel(row: FolderRow): FolderModel {
  return {
    id: row.id,
    parent_id: row.parent_id ?? null,
    user_id: row.user_id ?? '',
    name: row.name ?? '',
    items: parseJsonObj(row.items),
    meta: parseJsonObj(row.meta),
    data: parseJsonObj(row.data),
    is_expanded: row.is_expanded == null ? false : Boolean(row.is_expanded),
    created_at: row.created_at ?? 0,
    updated_at: row.updated_at ?? 0,
  };
}

const nowSec = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// FolderTable operations
// ---------------------------------------------------------------------------

export async function insertNewFolder(
  userId: string,
  form: FolderForm,
  parentId?: string | null
): Promise<FolderModel | null> {
  const id = crypto.randomUUID();
  const now = nowSec();
  // Python: form_data.model_dump(exclude_unset=True) — only client-provided keys
  const data: Record<string, unknown> = {
    id,
    user_id: userId,
    name: form.name,
    parent_id: parentId ?? null,
    created_at: now,
    updated_at: now,
  };
  if ('data' in form) data.data = form.data == null ? null : JSON.stringify(form.data);
  if ('meta' in form) data.meta = form.meta == null ? null : JSON.stringify(form.meta);
  try {
    const row = await db.folder.create({ data: data as any });
    return folderRowToModel(row as unknown as FolderRow);
  } catch (e) {
    console.error('Error inserting a new folder:', e);
    return null;
  }
}

export async function getFolderByIdAndUserId(id: string, userId: string): Promise<FolderModel | null> {
  try {
    const row = await db.folder.findFirst({ where: { id, user_id: userId } });
    return row ? folderRowToModel(row as unknown as FolderRow) : null;
  } catch {
    return null;
  }
}

export async function getFolderById(id: string): Promise<FolderModel | null> {
  try {
    const row = await db.folder.findFirst({ where: { id } });
    return row ? folderRowToModel(row as unknown as FolderRow) : null;
  } catch {
    return null;
  }
}

export async function getFoldersByIds(ids: string[]): Promise<FolderModel[]> {
  if (!ids.length) return [];
  const rows = await db.folder.findMany({ where: { id: { in: ids } }, orderBy: { updated_at: 'desc' } });
  return rows.map((r) => folderRowToModel(r as unknown as FolderRow));
}

/**
 * Python: get_shared_folder_ids_for_user — {folder_id: highest_permission}
 * for folders shared with or by the user (direct, group, public user:* grants,
 * plus grants on any folder owned by the user).
 */
export async function getSharedFolderIdsForUser(
  userId: string,
  userGroupIds: string[]
): Promise<Record<string, string>> {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`access_grant.resource_id IN (SELECT folder.id FROM folder WHERE folder.user_id = ${userId})`,
    Prisma.sql`(access_grant.principal_type = 'user' AND access_grant.principal_id = '*')`,
    Prisma.sql`(access_grant.principal_type = 'user' AND access_grant.principal_id = ${userId})`,
  ];
  if (userGroupIds.length) {
    conditions.push(
      Prisma.sql`(access_grant.principal_type = 'group' AND access_grant.principal_id IN (${Prisma.join(userGroupIds)}))`
    );
  }
  const rows = await db.$queryRaw<Array<{ resource_id: string; permission: string }>>(
    Prisma.sql`SELECT access_grant.resource_id, access_grant.permission FROM access_grant WHERE access_grant.resource_type = 'folder' AND (${Prisma.join(
      conditions,
      ' OR '
    )})`
  );
  const folderPerms: Record<string, string> = {};
  for (const g of rows) {
    if (folderPerms[g.resource_id] !== 'write') folderPerms[g.resource_id] = g.permission;
  }
  return folderPerms;
}

export async function getChildrenFoldersByIdAndUserId(
  id: string,
  userId: string
): Promise<FolderModel[] | null> {
  try {
    const root = await db.folder.findFirst({ where: { id, user_id: userId } });
    if (!root) return null;
    const folders: FolderModel[] = [];
    const seen = new Set<string>([id]);
    const walk = async (folderId: string): Promise<void> => {
      const children = await getFoldersByParentIdAndUserId(folderId, userId);
      for (const child of children) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        await walk(child.id);
        folders.push(child);
      }
    };
    await walk(id);
    return folders;
  } catch {
    return null;
  }
}

export async function getFoldersByUserId(userId: string): Promise<FolderModel[]> {
  const rows = await db.folder.findMany({ where: { user_id: userId } });
  return rows.map((r) => folderRowToModel(r as unknown as FolderRow));
}

export async function getFolderByParentIdAndUserIdAndName(
  parentId: string | null,
  userId: string,
  name: string
): Promise<FolderModel | null> {
  try {
    const parentCond: Prisma.Sql =
      parentId == null ? Prisma.sql`folder.parent_id IS NULL` : Prisma.sql`folder.parent_id = ${parentId}`;
    const rows = await db.$queryRaw<Array<FolderRow>>(
      Prisma.sql`SELECT folder.id, folder.parent_id, folder.user_id, folder.name, folder.items, folder.meta, folder.data, folder.is_expanded, folder.created_at, folder.updated_at
        FROM folder WHERE ${parentCond} AND folder.user_id = ${userId} AND LOWER(folder.name) = LOWER(${name}) LIMIT 1`
    );
    return rows.length ? folderRowToModel(rows[0]) : null;
  } catch (e) {
    console.error('getFolderByParentIdAndUserIdAndName:', e);
    return null;
  }
}

export async function getFoldersByParentIdAndUserId(
  parentId: string | null,
  userId: string
): Promise<FolderModel[]> {
  const rows = await db.folder.findMany({
    where: { parent_id: parentId, user_id: userId },
    orderBy: { updated_at: 'desc' },
  });
  return rows.map((r) => folderRowToModel(r as unknown as FolderRow));
}

export async function getFolderIdsByIdAndUserIdInSubtree(id: string, userId: string): Promise<string[]> {
  const root = await db.folder.findFirst({ where: { id, user_id: userId } });
  if (!root) return [];
  const folderIds = new Set<string>([root.id]);
  const queue: FolderModel[] = [folderRowToModel(root as unknown as FolderRow)];
  while (queue.length) {
    const current = queue.pop()!;
    const children = await getFoldersByParentIdAndUserId(current.id, userId);
    for (const child of children) {
      if (!folderIds.has(child.id)) {
        folderIds.add(child.id);
        queue.push(child);
      }
    }
  }
  return [...folderIds];
}

export async function updateFolderParentIdByIdAndUserId(
  id: string,
  userId: string,
  parentId: string | null
): Promise<FolderModel | null> {
  try {
    const existing = await db.folder.findFirst({ where: { id, user_id: userId } });
    if (!existing) return null;
    const row = await db.folder.update({
      where: { id },
      data: { parent_id: parentId, updated_at: nowSec() },
    });
    return folderRowToModel(row as unknown as FolderRow);
  } catch (e) {
    console.error('update_folder:', e);
    return null;
  }
}

export async function updateFolderByIdAndUserId(
  id: string,
  userId: string,
  form: FolderUpdateForm
): Promise<FolderModel | null> {
  try {
    const existing = await db.folder.findFirst({ where: { id, user_id: userId } });
    if (!existing) return null;

    // Python: duplicate-name check uses the submitted name (may be None → IS NULL)
    const duplicate = await db.folder.findFirst({
      where: { name: (form.name ?? null) as any, parent_id: existing.parent_id, user_id: userId },
    });
    if (duplicate && duplicate.id !== id) return null;

    const data: Record<string, unknown> = { updated_at: nowSec() };
    if ('name' in form) data.name = form.name ?? null;
    if ('data' in form) {
      if (form.data == null) return null; // Python: {**folder.data, **None} raises → caught → None
      const currentData = parseJsonObj(existing.data) ?? {};
      data.data = JSON.stringify({ ...currentData, ...form.data });
    }
    if ('meta' in form) {
      if (form.meta == null) return null;
      const currentMeta = parseJsonObj(existing.meta) ?? {};
      data.meta = JSON.stringify({ ...currentMeta, ...form.meta });
    }
    const row = await db.folder.update({ where: { id }, data: data as any });
    return folderRowToModel(row as unknown as FolderRow);
  } catch (e) {
    console.error('update_folder:', e);
    return null;
  }
}

export async function updateFolderIsExpandedByIdAndUserId(
  id: string,
  userId: string,
  isExpanded: boolean
): Promise<FolderModel | null> {
  try {
    const existing = await db.folder.findFirst({ where: { id, user_id: userId } });
    if (!existing) return null;
    const row = await db.folder.update({
      where: { id },
      data: { is_expanded: isExpanded, updated_at: nowSec() },
    });
    return folderRowToModel(row as unknown as FolderRow);
  } catch (e) {
    console.error('update_folder:', e);
    return null;
  }
}

/** Returns the ids of the deleted folder subtree (root first, then descendants). */
export async function deleteFolderByIdAndUserId(id: string, userId: string): Promise<string[]> {
  try {
    const root = await db.folder.findFirst({ where: { id, user_id: userId } });
    if (!root) return [];
    const folderIds: string[] = [root.id];
    const seen = new Set<string>([root.id]);

    const deleteChildren = async (folderId: string): Promise<void> => {
      const children = await getFoldersByParentIdAndUserId(folderId, userId);
      for (const child of children) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        await deleteChildren(child.id);
        folderIds.push(child.id);
        await db.folder.delete({ where: { id: child.id } }).catch(() => undefined);
      }
    };
    await deleteChildren(root.id);
    await db.folder.delete({ where: { id: root.id } }).catch(() => undefined);
    return folderIds;
  } catch (e) {
    console.error('delete_folder:', e);
    return [];
  }
}

export function normalizeFolderName(name: string): string {
  return String(name)
    .replace(/[\s_]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Python: search_folders_by_names — exact normalized-name match + children. */
export async function searchFoldersByNames(userId: string, queries: string[]): Promise<FolderModel[]> {
  const normalizedQueries = queries.map(normalizeFolderName);
  if (!normalizedQueries.length) return [];
  const results = new Map<string, FolderModel>();
  const folders = await getFoldersByUserId(userId);
  for (const folder of folders) {
    if (normalizedQueries.includes(normalizeFolderName(folder.name))) {
      results.set(folder.id, folder);
      const children = await getChildrenFoldersByIdAndUserId(folder.id, userId);
      if (children) {
        for (const child of children) results.set(child.id, child);
      }
    }
  }
  return [...results.values()];
}

// ---------------------------------------------------------------------------
// Port of open_webui/utils/access_control/folders.py
// ---------------------------------------------------------------------------

/** Check user access to a folder directly or via ancestor inheritance. */
export async function hasFolderAccess(
  userId: string,
  folder: FolderModel | null,
  permission: string
): Promise<boolean> {
  const seen = new Set<string>();
  let current = folder;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.user_id === userId) return true;
    if (await hasAccessGrant(userId, 'folder', current.id, permission)) return true;
    current = current.parent_id ? await getFolderById(current.parent_id) : null;
  }
  return false;
}

/** Check write access on the folder with this id; false when it does not exist. */
export async function hasFolderWriteAccess(userId: string, folderId: string): Promise<boolean> {
  const folder = await getFolderById(folderId);
  if (!folder) return false;
  return hasFolderAccess(userId, folder, 'write');
}

/**
 * Only the owner may reorganize another user's chat within the same folder tree.
 * (Python: utils/access_control/folders.has_chat_move_access)
 */
export async function hasChatMoveAccess(
  userId: string,
  sourceFolderId: string | null,
  targetFolderId: string | null
): Promise<boolean> {
  const getOwnedFolderRootId = async (folderId: string | null): Promise<string | null> => {
    const seen = new Set<string>();
    let sharedRootId: string | null = null;
    while (folderId && !seen.has(folderId)) {
      seen.add(folderId);
      const folder = await getFolderById(folderId);
      if (!folder || folder.user_id !== userId) return null;
      const hasGrant = await db.accessGrant.findFirst({
        where: { resource_type: 'folder', resource_id: folder.id },
      });
      if (hasGrant) sharedRootId = folder.id;
      if (!folder.parent_id) return sharedRootId ?? folder.id;
      folderId = folder.parent_id;
    }
    return null;
  };

  const sourceRootId = await getOwnedFolderRootId(sourceFolderId);
  return sourceRootId !== null && sourceRootId === (await getOwnedFolderRootId(targetFolderId));
}

/** Python: Automations.clear_folder_ids — detach automations from deleted folders. */
export async function clearAutomationFolderIds(userId: string, folderIds: string[]): Promise<number> {
  if (!folderIds.length) return 0;
  const result = await db.automation.updateMany({
    where: { user_id: userId, folder_id: { in: folderIds } },
    data: { folder_id: null, updated_at: Date.now() * 1e6 }, // time_ns parity
  });
  return result.count;
}
