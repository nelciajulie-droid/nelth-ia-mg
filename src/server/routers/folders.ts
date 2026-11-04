import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { configGet } from '@/lib/config';
import { env, ERROR_MESSAGES } from '@/lib/constants';
import { hasAccessGrant, hasPermission } from '@/lib/access-control';
import { getNoteFiles } from '@/lib/models/workspace';
import { userPermissionsConfig } from '@/lib/models/chats';
import {
  FolderForm,
  FolderModel,
  insertNewFolder,
  getFolderByIdAndUserId,
  getFolderById,
  getFoldersByIds,
  getSharedFolderIdsForUser,
  getChildrenFoldersByIdAndUserId,
  getFoldersByUserId,
  getFolderByParentIdAndUserIdAndName,
  getFoldersByParentIdAndUserId,
  getFolderIdsByIdAndUserIdInSubtree,
  updateFolderParentIdByIdAndUserId,
  updateFolderByIdAndUserId,
  updateFolderIsExpandedByIdAndUserId,
  deleteFolderByIdAndUserId,
  hasFolderAccess,
  clearAutomationFolderIds,
} from '@/lib/models/folders';
import {
  countUnreadByFolderIds,
  markChatsReadByFolderIds,
  getAllChatsByFolderId,
  countAllChatsByFolderId,
  getParticipantIdsByChatIds,
  countChatsByFolderIdsAndUserId,
  deleteChatsByUserIdAndFolderId,
  moveChatsByFolderId,
  getGrantsByResource,
  setAccessGrants,
  revokeAllAccess,
  validateAccessGrants,
} from '@/lib/models/chats';
import { Users } from '@/lib/models/users';
import { getGroupsByMemberId } from '@/lib/models/users';

/**
 * Port of open_webui/routers/folders.py (v0.12.5) — /api/v1/folders/*.
 *
 * Deviations:
 *  • publish_event calls are no-ops (no event bus runtime).
 *  • has_active_tasks (Redis) is always false — `active` flags stay false.
 *  • has_access_to_file is a close port using the Prisma tables; the model
 *    indirections (knowledge/model/channel/chat/note) are evaluated directly.
 */

const FOLDER_FILE_TYPES = new Set(['file', 'collection', 'note']);

function err(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

function requireUser(ctx: Ctx) {
  const user = ctx.user;
  if (!user) err(401, ERROR_MESSAGES.NOT_AUTHENTICATED);
  if (!['user', 'admin'].includes(user.role)) err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
  return user;
}

function queryBool(value: string | null): boolean {
  return value !== null && /^(true|1|yes|on)$/i.test(value);
}

function queryInt(ctx: Ctx, name: string, fallback: number | null): number | null {
  const raw = ctx.query.get(name);
  if (raw === null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Python: ERROR_MESSAGES.DEFAULT(msg). */
const DEFAULT_ERROR = (msg = ''): string => (msg ? `[ERROR: ${msg}]` : 'Something went wrong :/');

// ---------------------------------------------------------------------------
// Folder files access control (utils/access_control/files.py)
// ---------------------------------------------------------------------------

async function hasAccessToFile(
  fileId: string | null,
  accessType: 'read' | 'write',
  user: { id: string; role: string },
  userGroupIds?: Set<string>
): Promise<boolean> {
  if (!fileId) return false;
  const file = await db.file.findFirst({ where: { id: fileId } });
  if (!file) return false;

  if (file.user_id === user.id) return true;

  const groups = userGroupIds ?? new Set((await getGroupsByMemberId(user.id, true)).map((g) => g.id));

  // Knowledge bases containing the file
  const knowledgeFiles = await db.knowledgeFile.findMany({
    where: { file_id: fileId },
    select: { knowledge_id: true },
  });
  if (knowledgeFiles.length) {
    const knowledgeBases = await db.knowledge.findMany({
      where: { id: { in: knowledgeFiles.map((kf) => kf.knowledge_id) } },
    });
    for (const kb of knowledgeBases) {
      if (
        (kb.user_id === user.id ||
          (await hasAccessGrant(user.id, 'knowledge', kb.id, accessType, [...groups]))) &&
        (accessType === 'read' || kb.user_id === file.user_id)
      ) {
        return true;
      }
    }
  }

  // Channels the user can read that reference the file
  if (accessType === 'read') {
    const channelFiles = await db.channelFile.findMany({
      where: { file_id: fileId },
      select: { channel_id: true },
    });
    const channelIds = channelFiles.map((cf) => cf.channel_id);
    if (channelIds.length) {
      const channels = await db.channel.findMany({
        where: { id: { in: channelIds }, deleted_at: null, archived_at: null },
      });
      for (const channel of channels) {
        if (channel.type === 'group' || channel.type === 'dm') {
          const membership = await db.channelMember.findFirst({
            where: { channel_id: channel.id, user_id: user.id, is_active: true },
            select: { id: true },
          });
          if (membership) return true;
        } else {
          if (await hasAccessGrant(user.id, 'channel', channel.id, 'read', [...groups])) return true;
        }
      }
    }
  }

  // Shared chats (share link or folder audience) that reference the file
  if (accessType === 'read') {
    const chatFiles = await db.chatFile.findMany({
      where: { file_id: fileId },
      select: { chat_id: true },
    });
    const sharedChatIds = (
      await db.chat.findMany({
        where: { id: { in: chatFiles.map((cf) => cf.chat_id) }, OR: [{ share_id: { not: null } }, { folder_id: { not: null } }] },
        select: { id: true },
      })
    ).map((c) => c.id);
    if (sharedChatIds.length) {
      const granted = new Set(
        await accessibleResourceIds(user.id, 'shared_chat', sharedChatIds, 'read', groups)
      );
      if (granted.size) return true;
      const { getAccessibleChatById } = await import('@/lib/models/chats');
      for (const chatId of sharedChatIds) {
        if (await getAccessibleChatById(chatId, user)) return true;
      }
    }
  }

  // Notes owned by the file owner that attach the file (read only)
  if (accessType === 'read') {
    const notes = await db.note.findMany({
      where: { user_id: file.user_id ?? undefined },
      select: { id: true, data: true },
    });
    const noteIds = notes
      .filter((note) => {
        try {
          const data = note.data ? JSON.parse(note.data) : null;
          return getNoteFiles(data).some(
            (item: any) => item && item.type === 'file' && item.id === fileId
          );
        } catch {
          return false;
        }
      })
      .map((note) => note.id);
    if (noteIds.length) {
      const granted = await accessibleResourceIds(user.id, 'note', noteIds, 'read', groups);
      if (granted.length) return true;
    }
  }

  // Workspace models that attach the file
  const modelRows = await db.model.findMany({
    where: { meta: { contains: fileId } },
    select: { id: true, user_id: true, base_model_id: true, meta: true },
  });
  const includeBackground = accessType === 'read';
  const modelOwners: Record<string, string> = {};
  for (const model of modelRows) {
    if (!includeBackground && model.base_model_id === null) continue;
    let meta: Record<string, any> | null = null;
    try {
      meta = model.meta ? JSON.parse(model.meta) : null;
    } catch {
      meta = null;
    }
    if (!meta) continue;
    const attached =
      (meta.knowledge ?? []).some(
        (item: any) => item && item.type === 'file' && item.id === fileId
      ) ||
      (includeBackground &&
        (meta.background_image_url === `/api/v1/files/${fileId}/content` ||
          meta.voice_avatar?.file_id === fileId ||
          [...Object.values(meta.voice_avatar?.states ?? {}), ...(meta.voice_avatar?.gestures ?? [])].some(
            (asset: any) => asset?.file_id === fileId
          )));
    if (attached) modelOwners[model.id] = model.user_id ?? '';
  }
  if (accessType !== 'read') {
    for (const modelId of Object.keys(modelOwners)) {
      if (modelOwners[modelId] !== file.user_id) delete modelOwners[modelId];
    }
  }
  if (Object.values(modelOwners).includes(user.id)) return true;
  const grantedModels = await accessibleResourceIds(user.id, 'model', Object.keys(modelOwners), accessType, groups);
  return grantedModels.length > 0;
}

async function accessibleResourceIds(
  userId: string,
  resourceType: string,
  resourceIds: string[],
  permission: 'read' | 'write',
  userGroupIds: Set<string>
): Promise<string[]> {
  if (!resourceIds.length) return [];
  const rows = await db.accessGrant.findMany({
    where: {
      resource_type: resourceType,
      resource_id: { in: resourceIds },
      permission,
      OR: [
        { principal_type: 'user', principal_id: '*' },
        { principal_type: 'user', principal_id: userId },
        ...(userGroupIds.size
          ? [{ principal_type: 'group', principal_id: { in: [...userGroupIds] } }]
          : []),
      ],
    },
    select: { resource_id: true },
  });
  return [...new Set(rows.map((r) => r.resource_id))];
}

/** Python: Knowledges.check_access_by_user_id */
async function knowledgeCheckAccess(
  id: string,
  userId: string,
  permission: 'read' | 'write',
  userGroupIds: Set<string>
): Promise<boolean> {
  const knowledge = await db.knowledge.findFirst({ where: { id } });
  if (!knowledge) return false;
  if (knowledge.user_id === userId) return true;
  return hasAccessGrant(userId, 'knowledge', id, permission, [...userGroupIds]);
}

async function getAccessibleFolderFiles(
  entries: any,
  user: { id: string; role: string },
  userGroupIds?: Set<string>
): Promise<Record<string, any>[]> {
  if (!Array.isArray(entries)) return [];
  const valid = entries.filter(
    (entry: any) =>
      entry !== null &&
      typeof entry === 'object' &&
      FOLDER_FILE_TYPES.has(entry.type) &&
      typeof entry.id === 'string' &&
      entry.id
  );
  if (user.role === 'admin') return valid;

  const groups = userGroupIds ?? new Set((await getGroupsByMemberId(user.id, true)).map((g) => g.id));

  const accessible: Record<string, any>[] = [];
  for (const entry of valid) {
    if (entry.type === 'file') {
      if (await hasAccessToFile(entry.id, 'read', user, groups)) accessible.push(entry);
    } else if (entry.type === 'collection') {
      if (await knowledgeCheckAccess(entry.id, user.id, 'read', groups)) accessible.push(entry);
    } else if (entry.type === 'note') {
      const note = await db.note.findFirst({ where: { id: entry.id } });
      if (
        note &&
        (note.user_id === user.id ||
          (await hasAccessGrant(user.id, 'note', entry.id, 'read', [...groups])))
      ) {
        accessible.push(entry);
      }
    }
  }
  return accessible;
}

async function canReadAllFolderFiles(
  entries: any,
  user: { id: string; role: string }
): Promise<boolean> {
  if (entries === null || entries === undefined) return true;
  if (!Array.isArray(entries)) return false;
  if (!entries.length) return true;
  return (await getAccessibleFolderFiles(entries, user)).length === entries.length;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function getFolderUnreadCounts(userId: string): Promise<Record<string, number>> {
  const userFolders = await getFoldersByUserId(userId);
  const parentById: Record<string, string | null> = {};
  for (const folder of userFolders) parentById[folder.id] = folder.parent_id;
  const unreadCounts: Record<string, number> = {};
  for (const id of Object.keys(parentById)) unreadCounts[id] = 0;

  const directUnreadCounts = await countUnreadByFolderIds(userId, Object.keys(parentById));
  for (const [unreadFolderId, unreadCount] of Object.entries(directUnreadCounts)) {
    let currentId: string | null = unreadFolderId;
    const seen = new Set<string>();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      if (currentId in unreadCounts) unreadCounts[currentId] += unreadCount;
      currentId = parentById[currentId] ?? null;
    }
  }
  return unreadCounts;
}

/** Python: check_folders_permission */
async function checkFoldersPermission(user: { id: string; role: string }): Promise<void> {
  const foldersEnabled = await configGet<boolean>('folders.enable', env.ENABLE_FOLDERS);
  if (foldersEnabled === false) err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
  if (user.role !== 'admin') {
    const permissions = await userPermissionsConfig();
    if (!(await hasPermission(user.id, 'features.folders', permissions))) {
      err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
    }
  }
}

function folderDump(folder: FolderModel): Record<string, unknown> {
  return { ...folder };
}

function accessGrantDumps(grants: Awaited<ReturnType<typeof getGrantsByResource>>) {
  return grants.map((g) => ({
    id: g.id,
    resource_type: g.resource_type,
    resource_id: g.resource_id,
    principal_type: g.principal_type,
    principal_id: g.principal_id,
    permission: g.permission,
    created_at: g.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // GET / — list folders with unread counts (FolderNameIdResponse)
  {
    method: 'GET',
    path: '',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkFoldersPermission(user);

      const folders = await getFoldersByUserId(user.id);
      const parentById: Record<string, string | null> = {};
      for (const folder of folders) parentById[folder.id] = folder.parent_id;

      const isInParentCycle = (folderId: string): boolean => {
        const seenIds = new Set<string>([folderId]);
        let currentId = parentById[folderId] ?? null;
        while (currentId && !seenIds.has(currentId)) {
          seenIds.add(currentId);
          currentId = parentById[currentId] ?? null;
        }
        return currentId === folderId;
      };

      let userGroupIds: Set<string> | undefined;
      if (user.role !== 'admin' && folders.some((f) => f.data && 'files' in f.data)) {
        userGroupIds = new Set((await getGroupsByMemberId(user.id, true)).map((g) => g.id));
      }

      // Verify folder data integrity
      const folderList: FolderModel[] = [];
      for (let folder of folders) {
        // A missing or looping parent hides the folder from the tree — reset to root
        if (folder.parent_id && (!(folder.parent_id in parentById) || isInParentCycle(folder.id))) {
          parentById[folder.id] = null;
          folder = (await updateFolderParentIdByIdAndUserId(folder.id, user.id, null)) ?? folder;
        }

        if (folder.data && 'files' in folder.data) {
          const accessibleFiles = await getAccessibleFolderFiles(folder.data.files, user, userGroupIds);
          const existingFiles = Array.isArray(folder.data.files) ? folder.data.files : [];
          if (accessibleFiles.length !== existingFiles.length) {
            folder.data.files = accessibleFiles;
            await updateFolderByIdAndUserId(folder.id, user.id, { data: folder.data });
          }
        }

        folderList.push(folder);
      }

      const unreadCounts = await getFolderUnreadCounts(user.id);

      return ctx.json(
        folderList.map((folder) => ({
          id: folder.id,
          user_id: folder.user_id,
          name: folder.name,
          meta: folder.meta,
          parent_id: folder.parent_id,
          is_expanded: folder.is_expanded,
          unread_count: unreadCounts[folder.id] ?? 0,
          created_at: folder.created_at,
          updated_at: folder.updated_at,
        }))
      );
    },
  },

  // POST / — create folder
  {
    method: 'POST',
    path: '',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkFoldersPermission(user);

      const form = await ctx.body<Record<string, any>>();
      if (typeof form.name !== 'string') err(422, "Field required: 'name'");
      const folderForm: Record<string, any> = { name: form.name };
      if ('data' in form) folderForm.data = form.data ?? null;
      if ('meta' in form) folderForm.meta = form.meta ?? null;
      if ('parent_id' in form) folderForm.parent_id = form.parent_id ?? null;

      const existing = await getFolderByParentIdAndUserIdAndName(
        form.parent_id ?? null,
        user.id,
        form.name
      );
      if (existing) err(400, DEFAULT_ERROR('Folder already exists'));

      if (form.data && 'files' in form.data && !(await canReadAllFolderFiles(form.data.files, user))) {
        err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      // Creating a subfolder in a shared folder?
      if (form.parent_id) {
        const parent = await getFolderById(form.parent_id);
        if (parent && parent.user_id !== user.id) {
          if (user.role !== 'admin' && !(await hasFolderAccess(user.id, parent, 'write'))) {
            err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
          }
          if (form.data && 'files' in form.data) {
            const owner = await Users.getUserById(parent.user_id);
            if (!owner) err(404, ERROR_MESSAGES.NOT_FOUND);
            if (!(await canReadAllFolderFiles(form.data.files, owner))) {
              err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
            }
          }
          // Create as the folder owner's subfolder (keep tree consistent)
          const folder = await insertNewFolder(parent.user_id, folderForm as FolderForm, form.parent_id);
          if (!folder) err(400, DEFAULT_ERROR('Error creating folder'));
          return ctx.json(folderDump(folder));
        }
      }

      const folder = await insertNewFolder(user.id, folderForm as FolderForm, form.parent_id ?? null);
      if (!folder) err(400, DEFAULT_ERROR('Error creating folder'));
      return ctx.json(folderDump(folder));
    },
  },

  // GET /shared — folders shared with or by the session user
  {
    method: 'GET',
    path: 'shared',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkFoldersPermission(user);

      const groups = await getGroupsByMemberId(user.id, true);
      const groupIds = groups.map((g) => g.id);

      const folderPerms = await getSharedFolderIdsForUser(user.id, groupIds);
      const sharedFolders = await getFoldersByIds(Object.keys(folderPerms));

      const owners = await Users.getUsersByUserIds([...new Set(sharedFolders.map((f) => f.user_id))]);
      const ownerNames = new Map(owners.map((owner) => [owner.id, owner.name]));

      const results: Record<string, any>[] = sharedFolders.map((folder) => ({
        ...folderDump(folder),
        owner_name: ownerNames.get(folder.user_id) ?? 'Unknown',
        permission: folder.user_id === user.id ? 'write' : folderPerms[folder.id],
      }));

      // Child folders inherit their parent's grant
      const resultById = new Map(results.map((folder) => [folder.id, folder]));
      for (const folder of sharedFolders) {
        const children = (await getChildrenFoldersByIdAndUserId(folder.id, folder.user_id)) ?? [];
        for (const child of children) {
          const permission =
            folder.user_id === user.id || child.user_id === user.id ? 'write' : folderPerms[folder.id];
          if (resultById.has(child.id)) {
            if (permission === 'write') resultById.get(child.id)!.permission = 'write';
          } else {
            const entry = {
              ...folderDump(child),
              owner_name: ownerNames.get(child.user_id) ?? 'Unknown',
              permission,
            };
            resultById.set(child.id, entry);
            results.push(entry);
          }
        }
      }

      return ctx.json(results);
    },
  },

  // GET /{id} — folder with grants + write flag
  {
    method: 'GET',
    path: ':id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkFoldersPermission(user);
      const id = ctx.params.id;

      const folder = await getFolderByIdAndUserId(id, user.id);
      if (folder) {
        const grants = await getGrantsByResource('folder', id);
        return ctx.json({
          ...folderDump(folder),
          access_grants: accessGrantDumps(grants),
          write_access: true,
        });
      }

      // Check shared access
      const shared = await getFolderById(id);
      if (shared && (user.role === 'admin' || (await hasFolderAccess(user.id, shared, 'read')))) {
        const grants = await getGrantsByResource('folder', id);
        return ctx.json({
          ...folderDump(shared),
          access_grants: accessGrantDumps(grants),
          write_access: user.role === 'admin' || (await hasFolderAccess(user.id, shared, 'write')),
        });
      }

      err(404, ERROR_MESSAGES.NOT_FOUND);
    },
  },

  // POST /{id}/update — update folder name/data/meta
  {
    method: 'POST',
    path: ':id/update',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkFoldersPermission(user);
      const id = ctx.params.id;

      let folder = await getFolderByIdAndUserId(id, user.id);
      if (!folder) {
        // Check shared write access
        folder = await getFolderById(id);
        if (!folder || (user.role !== 'admin' && !(await hasFolderAccess(user.id, folder, 'write')))) {
          err(404, ERROR_MESSAGES.NOT_FOUND);
        }
      }

      const form = await ctx.body<Record<string, any>>();
      const patch: Record<string, any> = {};
      if ('name' in form) patch.name = form.name ?? null;
      if ('data' in form) patch.data = form.data ?? null;
      if ('meta' in form) patch.meta = form.meta ?? null;

      if (
        user.role !== 'admin' &&
        user.id !== folder.user_id &&
        form.data &&
        'share_mode' in form.data &&
        form.data.share_mode !== (folder.data ?? {}).share_mode
      ) {
        err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      if (form.name !== null && form.name !== undefined) {
        const existingFolder = await getFolderByParentIdAndUserIdAndName(
          folder.parent_id,
          folder.user_id,
          form.name
        );
        if (existingFolder && existingFolder.id !== id) {
          err(400, DEFAULT_ERROR('Folder already exists'));
        }
      }

      if (form.data && 'files' in form.data) {
        const owner = folder.user_id === user.id ? user : await Users.getUserById(folder.user_id);
        if (!owner) err(404, ERROR_MESSAGES.NOT_FOUND);
        if (!(await canReadAllFolderFiles(form.data.files, owner))) {
          err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
        }

        // Editors send back the owner's existing entries — only new ones are
        // checked against the editor.
        const existingFiles = (folder.data ?? {}).files ?? [];
        const addedFiles = (Array.isArray(form.data.files) ? form.data.files : []).filter(
          (entry: any) => !existingFiles.includes(entry)
        );
        if (!(await canReadAllFolderFiles(addedFiles, user))) {
          err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
        }
      }

      const updated = await updateFolderByIdAndUserId(id, folder.user_id, patch);
      if (!updated) err(400, DEFAULT_ERROR('Error updating folder'));
      return ctx.json(folderDump(updated));
    },
  },

  // POST /{id}/update/parent — move a folder
  {
    method: 'POST',
    path: ':id/update/parent',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkFoldersPermission(user);
      const id = ctx.params.id;

      const folder = await getFolderByIdAndUserId(id, user.id);
      if (folder) {
        const form = await ctx.body<{ parent_id?: string | null }>();
        const parentId = form.parent_id ?? null;

        const existingFolder = await getFolderByParentIdAndUserIdAndName(parentId, user.id, folder.name);
        if (existingFolder && existingFolder.id !== id) {
          err(400, DEFAULT_ERROR('Folder already exists'));
        }

        if (parentId && (await getFolderIdsByIdAndUserIdInSubtree(id, user.id)).includes(parentId)) {
          err(400, DEFAULT_ERROR('Cannot move a folder into itself or one of its subfolders'));
        }

        const updated = await updateFolderParentIdByIdAndUserId(id, user.id, parentId);
        if (!updated) err(400, DEFAULT_ERROR('Error updating folder'));
        return ctx.json(folderDump(updated));
      }
      err(404, ERROR_MESSAGES.NOT_FOUND);
    },
  },

  // POST /{id}/update/expanded — toggle expanded state
  {
    method: 'POST',
    path: ':id/update/expanded',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkFoldersPermission(user);
      const id = ctx.params.id;

      let folder = await getFolderByIdAndUserId(id, user.id);
      if (!folder) {
        folder = await getFolderById(id);
        if (folder && (user.role === 'admin' || (await hasFolderAccess(user.id, folder, 'read')))) {
          return ctx.json(folderDump(folder));
        }
      }

      if (folder) {
        const form = await ctx.body<{ is_expanded?: boolean }>();
        const updated = await updateFolderIsExpandedByIdAndUserId(id, user.id, Boolean(form.is_expanded));
        if (!updated) err(400, DEFAULT_ERROR('Error updating folder'));
        return ctx.json(folderDump(updated));
      }
      err(404, ERROR_MESSAGES.NOT_FOUND);
    },
  },

  // POST /{id}/access/update — update folder sharing
  {
    method: 'POST',
    path: ':id/access/update',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkFoldersPermission(user);
      const id = ctx.params.id;

      const folder = await getFolderById(id);
      if (!folder) err(404, ERROR_MESSAGES.NOT_FOUND);

      // Editing folder contents does not grant permission to manage sharing.
      if (user.role !== 'admin' && user.id !== folder.user_id) {
        err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const form = await ctx.body<{
        access_grants?: any[];
        share_mode?: string | null;
      }>();
      const accessGrants = await validateAccessGrants(
        await userPermissionsConfig(),
        user.id,
        user.role,
        form.access_grants ?? [],
        'folder'
      );

      await setAccessGrants('folder', id, accessGrants);
      const shareModeProvided = 'share_mode' in (form ?? {});
      let responseFolder = folder;
      if (shareModeProvided) {
        responseFolder =
          (await updateFolderByIdAndUserId(id, folder.user_id, {
            data: { share_mode: form.share_mode ?? null } as Record<string, any>,
          })) ?? folder;
      }

      const grants = await getGrantsByResource('folder', id);
      return ctx.json({
        ...folderDump(responseFolder),
        access_grants: accessGrantDumps(grants),
      });
    },
  },

  // GET /{id}/shared/chats — chats inside a shared folder
  {
    method: 'GET',
    path: ':id/shared/chats',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkFoldersPermission(user);
      const id = ctx.params.id;

      const folder = await getFolderById(id);
      if (!folder) err(404, ERROR_MESSAGES.NOT_FOUND);

      const isOwner = user.id === folder.user_id;
      const isAdmin = user.role === 'admin';
      const hasWrite = isOwner || isAdmin || (await hasFolderAccess(user.id, folder, 'write'));
      const hasRead = hasWrite || (await hasFolderAccess(user.id, folder, 'read'));

      if (!hasRead) err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);

      const page = queryInt(ctx, 'page', null);
      const sortBy = ctx.query.get('sort_by') ?? 'unread_updated_at';
      const sortDir = ctx.query.get('sort_dir') ?? 'desc';

      const limit = 10;
      const skip = page !== null ? (page - 1) * limit : 0;
      const chats = await getAllChatsByFolderId(
        id,
        skip,
        page !== null ? limit : 60,
        sortBy,
        sortDir,
        user.id
      );
      const total =
        page !== null ? await countAllChatsByFolderId(id) : chats.length;

      const participantIds = await getParticipantIdsByChatIds(chats.map((chat) => chat.id));
      const userIds = new Set<string>(chats.map((chat) => chat.user_id));
      for (const ids of Object.values(participantIds)) for (const uid of ids) userIds.add(uid);
      const users = userIds.size ? await Users.getUsersByUserIds([...userIds]) : [];
      const names = new Map(users.map((u) => [u.id, u.name]));

      for (const chat of chats) {
        const uid = chat.user_id;
        (chat as any).owner_name = names.get(uid) ?? 'Unknown';
        (chat as any).participants = (participantIds[chat.id] ?? [])
          .map((authorId) => ({ id: authorId, name: names.get(authorId) ?? null }))
          .sort((a, b) => {
            const aOwner = a.id !== uid;
            const bOwner = b.id !== uid;
            if (aOwner !== bOwner) return aOwner ? 1 : -1;
            const aName = Boolean(a.name);
            const bName = Boolean(b.name);
            if (aName !== bName) return aName ? -1 : 1;
            const aFold = (a.name ?? '').toLowerCase();
            const bFold = (b.name ?? '').toLowerCase();
            if (aFold !== bFold) return aFold < bFold ? -1 : 1;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          });
        (chat as any).active = false;
        if (chat.user_id !== user.id) {
          (chat as any).last_read_at = chat.updated_at;
        }
        // Redis task tracking is not available; active stays false.
      }

      const response: Record<string, any> = {
        chats: chats.map((chat) => ({ ...chat, readonly: chat.user_id !== user.id })),
        folder_permission: hasWrite ? 'write' : 'read',
      };
      if (page !== null) {
        response.total = total;
        response.has_more = skip + limit < total;
      }
      return ctx.json(response);
    },
  },

  // POST /{id}/read — mark folder chats read
  {
    method: 'POST',
    path: ':id/read',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkFoldersPermission(user);
      const id = ctx.params.id;

      const folder = await getFolderById(id);
      if (!folder) err(404, ERROR_MESSAGES.NOT_FOUND);

      const isOwner = user.id === folder.user_id;
      const isAdmin = user.role === 'admin';
      if (!(isOwner || isAdmin || (await hasFolderAccess(user.id, folder, 'read')))) {
        err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const folderIds =
        isOwner || isAdmin
          ? await getFolderIdsByIdAndUserIdInSubtree(id, folder.user_id)
          : [id];
      const updatedCount = await markChatsReadByFolderIds(user.id, folderIds);

      return ctx.json({
        folder_id: id,
        folder_ids: folderIds,
        updated_count: updatedCount,
        folder_unread_counts: await getFolderUnreadCounts(user.id),
      });
    },
  },

  // DELETE /{id} — delete folder (optionally with contents)
  {
    method: 'DELETE',
    path: ':id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkFoldersPermission(user);
      const id = ctx.params.id;
      const deleteContents = ctx.query.get('delete_contents') === null ? true : queryBool(ctx.query.get('delete_contents'));

      let folder = await getFolderByIdAndUserId(id, user.id);
      if (!folder) {
        // Deletion cascades into the owner's data — owner or admin only
        folder = await getFolderById(id);
        if (!folder) err(404, ERROR_MESSAGES.NOT_FOUND);
        if (user.role !== 'admin') err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const folderOwnerId = folder.user_id;

      const subtreeIds = await getFolderIdsByIdAndUserIdInSubtree(id, folderOwnerId);
      if (
        deleteContents &&
        (await countChatsByFolderIdsAndUserId(subtreeIds, folderOwnerId)) > 0
      ) {
        const chatDeletePermission = await hasPermission(
          user.id,
          'chat.delete',
          await userPermissionsConfig()
        );
        if (user.role !== 'admin' && !chatDeletePermission) {
          err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
        }
      }

      const deletedIds = await deleteFolderByIdAndUserId(id, folderOwnerId);
      for (const folderId of deletedIds) {
        if (deleteContents) {
          await deleteChatsByUserIdAndFolderId(folderOwnerId, folderId);
        }
        await moveChatsByFolderId(folderId, null);
        await revokeAllAccess('folder', folderId);
      }

      await clearAutomationFolderIds(folderOwnerId, deletedIds);
      return ctx.json(true);
    },
  },
];
