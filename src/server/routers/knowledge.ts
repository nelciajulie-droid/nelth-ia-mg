import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { DEFAULT_USER_PERMISSIONS, ERROR_MESSAGES } from '@/lib/constants';
import { configGet } from '@/lib/config';
import type { ApiUser } from '@/lib/auth';
import { getPermissions, getUserGroupIds, hasAccessGrant } from '@/lib/access-control';
import { deleteChunksForCollection } from '@/lib/retrieval/embeddings';
import {
  RAG_ERRORS,
  deleteFileResource,
  deleteChunksForFileInCollection,
  embedKnowledgeBaseMetadata,
  fileMetadataResponse,
  getFileById,
  hasAccessToFile,
  indexFile,
  KNOWLEDGE_BASES_COLLECTION,
  removeKnowledgeBaseMetadataEmbedding,
  rowToFileModel,
  safeJson,
  type FileModel,
  type FileRow,
} from '@/lib/retrieval/process';

/**
 * /api/v1/knowledge — port of open_webui/routers/knowledge.py (v0.12.5).
 *
 * Documented deviations:
 *   - external knowledge connectors (/knowledge/external/*) are not ported;
 *     knowledge bases with meta.source === 'external' are read-only exactly
 *     like python's mutation guards.
 *   - vector-db operations use the Prisma `chunk` store.
 *   - event publishing is not ported.
 */

const PAGE_ITEM_COUNT = 30;
const KNOWLEDGE_SORTABLE_FIELDS = new Set(['name', 'created_at', 'updated_at']);
const ENABLE_KNOWLEDGE_FILE_RETENTION =
  (process.env.ENABLE_KNOWLEDGE_FILE_RETENTION || 'False').toLowerCase() === 'true';
const BYPASS_ADMIN_ACCESS_CONTROL = (
  process.env.BYPASS_ADMIN_ACCESS_CONTROL ??
  process.env.ENABLE_ADMIN_WORKSPACE_CONTENT_ACCESS ??
  'True'
).toLowerCase() === 'true';

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

type KnowledgeRow = {
  id: string;
  user_id: string | null;
  name: string | null;
  description: string | null;
  meta: string | null;
  created_at: number | null;
  updated_at: number | null;
};

type AccessGrantModel = {
  id: string;
  resource_type: string;
  resource_id: string;
  principal_type: string;
  principal_id: string;
  permission: string;
  created_at: number;
};

type KnowledgeModel = {
  id: string;
  user_id: string | null;
  name: string;
  description: string;
  meta: Record<string, any> | null;
  access_grants: AccessGrantModel[];
  created_at: number;
  updated_at: number;
};

type DirectoryRow = {
  id: string;
  knowledge_id: string;
  parent_id: string | null;
  name: string;
  user_id: string;
  created_at: number;
  updated_at: number;
};

function directoryModel(d: DirectoryRow) {
  return {
    id: d.id,
    knowledge_id: d.knowledge_id,
    parent_id: d.parent_id,
    name: d.name,
    user_id: d.user_id,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

async function grantsForResources(knowledgeIds: string[]): Promise<Map<string, AccessGrantModel[]>> {
  const map = new Map<string, AccessGrantModel[]>(knowledgeIds.map((id) => [id, []]));
  if (knowledgeIds.length === 0) return map;
  const grants = await db.accessGrant.findMany({
    where: { resource_type: 'knowledge', resource_id: { in: knowledgeIds } },
  });
  for (const g of grants) {
    const list = map.get(g.resource_id);
    if (list) list.push(g as AccessGrantModel);
  }
  return map;
}

async function toKnowledgeModel(row: KnowledgeRow): Promise<KnowledgeModel> {
  const grants = await db.accessGrant.findMany({
    where: { resource_type: 'knowledge', resource_id: row.id },
  });
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name ?? '',
    description: row.description ?? '',
    meta: safeJson(row.meta),
    access_grants: grants as AccessGrantModel[],
    created_at: row.created_at ?? 0,
    updated_at: row.updated_at ?? 0,
  };
}

async function getKnowledgeById(id: string): Promise<KnowledgeModel | null> {
  const row = (await db.knowledge.findUnique({ where: { id } })) as KnowledgeRow | null;
  return row ? await toKnowledgeModel(row) : null;
}

function knowledgeResponse(knowledge: KnowledgeModel, files: any[] | null = null) {
  return { ...knowledge, files };
}

function userResponse(userId: string | null, users: Map<string, any>): Record<string, any> | null {
  if (!userId) return null;
  const u = users.get(userId);
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    profile_image_url: u.profile_image_url,
  };
}

function isExternalKnowledge(knowledge: KnowledgeModel): boolean {
  return (knowledge.meta ?? {})['source'] === 'external';
}

/** file.data minus the heavy base64 payload (list responses). */
function stripFileBytesData(data: Record<string, any> | null): Record<string, any> | null {
  if (!data || typeof data !== 'object' || !('content_base64' in data)) return data ?? null;
  const { content_base64, ...rest } = data;
  void content_base64;
  return rest;
}

function externalKnowledgeError(): never {
  throw new HttpError(400, 'External knowledge bases are read-only.');
}

// ---------------------------------------------------------------------------
// Access helpers
// ---------------------------------------------------------------------------

async function verifyKnowledgeWriteAccess(id: string, user: ApiUser): Promise<KnowledgeModel> {
  const knowledge = await getKnowledgeById(id);
  if (!knowledge) throw new HttpError(404, ERROR_MESSAGES.NOT_FOUND);
  if (isExternalKnowledge(knowledge)) externalKnowledgeError();
  if (
    knowledge.user_id !== user.id &&
    !(await hasAccessGrant(user.id, 'knowledge', knowledge.id, 'write')) &&
    user.role !== 'admin'
  ) {
    throw new HttpError(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
  }
  return knowledge;
}

async function canManageKnowledge(knowledge: KnowledgeModel, user: ApiUser): Promise<boolean> {
  return (
    knowledge.user_id === user.id ||
    user.role === 'admin' ||
    (await hasAccessGrant(user.id, 'knowledge', knowledge.id, 'write'))
  );
}

/** Port of normalize_access_grants. */
function normalizeAccessGrants(accessGrants: any[]): AccessGrantModel[] {
  if (!Array.isArray(accessGrants)) return [];
  const deduped = new Map<string, AccessGrantModel>();
  for (const grant of accessGrants) {
    if (!grant || typeof grant !== 'object') continue;
    const principalType = grant['principal_type'];
    const principalId = grant['principal_id'];
    const permission = grant['permission'];
    if (!['user', 'group', 'anyone'].includes(principalType)) continue;
    if (!['read', 'write'].includes(permission)) continue;
    if (typeof principalId !== 'string' || !principalId) continue;
    if (principalType === 'anyone' && (principalId !== '*' || permission !== 'read')) continue;
    const key = `${principalType}:${principalId}:${permission}`;
    deduped.set(key, {
      id:
        typeof grant['id'] === 'string' && grant['id']
          ? grant['id']
          : crypto.randomUUID(),
      resource_type: 'knowledge',
      resource_id: '',
      principal_type: principalType,
      principal_id: principalId,
      permission,
      created_at: 0,
    });
  }
  return [...deduped.values()];
}

/** Port of AccessGrants.set_access_grants (replace all grants for a resource). */
async function setAccessGrants(
  resourceType: string,
  resourceId: string,
  accessGrants: any[]
): Promise<AccessGrantModel[]> {
  const normalized = normalizeAccessGrants(accessGrants).map((g) => ({
    ...g,
    resource_type: resourceType,
    resource_id: resourceId,
  }));
  await db.accessGrant.deleteMany({ where: { resource_type: resourceType, resource_id: resourceId } });
  if (normalized.length > 0) {
    await db.accessGrant.createMany({
      data: normalized.map((g) => ({
        id: g.id,
        resource_type: g.resource_type,
        resource_id: g.resource_id,
        principal_type: g.principal_type,
        principal_id: g.principal_id,
        permission: g.permission,
        created_at: Math.floor(Date.now() / 1000),
      })),
    });
  }
  return normalized.map((g) => ({ ...g, created_at: Math.floor(Date.now() / 1000) }));
}

/** Port of filter_allowed_access_grants (resource_type='knowledge'). */
async function filterAllowedAccessGrants(
  userId: string,
  userRole: string,
  accessGrants: any[]
): Promise<any[]> {
  let grants: any[] = normalizeAccessGrants(accessGrants).map((g) => ({ ...g }));
  if (userRole === 'admin' || grants.length === 0) return grants;

  const defaultPermissions = await configGet<any>('user.permissions', DEFAULT_USER_PERMISSIONS);
  const permissions = await getPermissions(userId, defaultPermissions);
  const allowed = (key: string | null): boolean => {
    if (!key) return false;
    const [section, name] = key.split('.');
    return Boolean((permissions as any)?.[section]?.[name] ?? false);
  };
  if (!allowed('sharing.knowledge')) return [];
  // anyone grants unsupported for knowledge
  grants = grants.filter((g) => g['principal_type'] !== 'anyone');
  return grants.filter((g) => {
    if (g['principal_type'] === 'user' && g['principal_id'] === '*') {
      return allowed('sharing.public_knowledge');
    }
    if (g['principal_type'] === 'user') return allowed('access_grants.allow_users');
    return allowed('access_grants.allow_groups');
  });
}

// ---------------------------------------------------------------------------
// Search (models/knowledge.py search_knowledge_bases port)
// ---------------------------------------------------------------------------

type KnowledgeFilter = {
  query?: string;
  view_option?: string;
  source?: string;
  order_by?: string;
  direction?: string;
};

async function searchKnowledgeBases(
  user: ApiUser,
  filter: KnowledgeFilter,
  skip: number,
  limit: number
): Promise<{ items: any[]; total: number }> {
  const applyFilter = !(user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL);
  let rows = (await db.knowledge.findMany({})) as KnowledgeRow[];

  if (filter.query) {
    const q = filter.query.toLowerCase();
    const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean) as string[])];
    const users = userIds.length
      ? await db.user.findMany({ where: { id: { in: userIds } } })
      : [];
    const usersById = new Map(users.map((u) => [u.id, u]));
    rows = rows.filter((r) => {
      const u = r.user_id ? usersById.get(r.user_id) : null;
      return (
        (r.name ?? '').toLowerCase().includes(q) ||
        (r.description ?? '').toLowerCase().includes(q) ||
        (u?.name ?? '').toLowerCase().includes(q) ||
        (u?.email ?? '').toLowerCase().includes(q) ||
        (u?.username ?? '').toLowerCase().includes(q)
      );
    });
  }
  if (filter.view_option === 'created') {
    rows = rows.filter((r) => r.user_id === user.id);
  } else if (filter.view_option === 'shared') {
    rows = rows.filter((r) => r.user_id !== user.id);
  }
  if (filter.source === 'external') {
    rows = rows.filter((r) => safeJson(r.meta)?.['source'] === 'external');
  } else if (filter.source === 'local') {
    rows = rows.filter((r) => safeJson(r.meta)?.['source'] !== 'external');
  }

  if (applyFilter) {
    const groupIds = await getUserGroupIds(user.id);
    const knowledgeIds = rows.map((r) => r.id);
    const grantsMap = await grantsForResources(knowledgeIds);
    rows = rows.filter((r) => {
      if (r.user_id === user.id) return true;
      const grants = grantsMap.get(r.id) ?? [];
      // PUBLIC-APP MODE: knowledge without any access grant is part of the
      // shared catalog — every member can read it.
      if (grants.length === 0) return true;
      return grants.some(
        (g) =>
          g.permission === 'read' &&
          ((g.principal_type === 'user' && (g.principal_id === '*' || g.principal_id === user.id)) ||
            (g.principal_type === 'group' && groupIds.includes(g.principal_id)))
      );
    });
  }

  // ordering (KNOWLEDGE_SORTABLE_FIELDS)
  const orderField = filter.order_by && KNOWLEDGE_SORTABLE_FIELDS.has(filter.order_by) ? filter.order_by : 'updated_at';
  const dir = (filter.direction ?? 'desc').toLowerCase() === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const av = (a as any)[orderField] ?? 0;
    const bv = (b as any)[orderField] ?? 0;
    if (av !== bv) return av > bv ? dir : -dir;
    return a.id < b.id ? -1 : 1;
  });

  const total = rows.length;
  const pageRows = rows.slice(skip, skip + limit);

  const knowledgeIds = pageRows.map((r) => r.id);
  const grantsMap = await grantsForResources(knowledgeIds);
  const fileCounts = new Map<string, number>();
  if (knowledgeIds.length > 0) {
    const grouped = await db.knowledgeFile.groupBy({
      by: ['knowledge_id'],
      where: { knowledge_id: { in: knowledgeIds } },
      _count: { _all: true },
    });
    for (const g of grouped) fileCounts.set(g.knowledge_id, g._count._all);
  }
  const userIds = [...new Set(pageRows.map((r) => r.user_id).filter(Boolean) as string[])];
  const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } } }) : [];
  const usersById = new Map(users.map((u) => [u.id, u]));

  const items: any[] = [];
  for (const row of pageRows) {
    const knowledge = await toKnowledgeModel(row);
    const grants = grantsMap.get(row.id) ?? [];
    knowledge.access_grants = grants;
    const writeAccess =
      user.id === knowledge.user_id ||
      (user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL) ||
      grants.some((g) => g.permission === 'write' && (
        (g.principal_type === 'user' && (g.principal_id === '*' || g.principal_id === user.id)) ||
        g.principal_type === 'group'
      ));
    items.push({
      ...knowledge,
      user: userResponse(row.user_id, usersById),
      file_count: fileCounts.get(row.id) ?? 0,
      write_access: writeAccess,
    });
  }
  return { items, total };
}

// ---------------------------------------------------------------------------
// File listing inside a knowledge base
// ---------------------------------------------------------------------------

async function getFilesWithDirectoryIds(
  knowledgeId: string
): Promise<Array<{ file: FileModel; directory_id: string | null }>> {
  const kbFiles = await db.knowledgeFile.findMany({ where: { knowledge_id: knowledgeId } });
  if (kbFiles.length === 0) return [];
  const rows = (await db.file.findMany({
    where: { id: { in: kbFiles.map((k) => k.file_id) } },
  })) as FileRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Array<{ file: FileModel; directory_id: string | null }> = [];
  for (const kbFile of kbFiles) {
    const row = byId.get(kbFile.file_id);
    if (row) out.push({ file: rowToFileModel(row), directory_id: kbFile.directory_id });
  }
  return out;
}

async function getKnowledgeFilesList(
  knowledgeId: string,
  userId: string,
  filter: {
    query?: string;
    include_content?: boolean;
    view_option?: string;
    order_by?: string;
    direction?: string;
    directory_id?: string | null;
  },
  skip: number,
  limit: number
) {
  let entries = await getFilesWithDirectoryIds(knowledgeId);

  if ('directory_id' in filter && filter.directory_id !== undefined) {
    entries = entries.filter((e) =>
      filter.directory_id ? e.directory_id === filter.directory_id : e.directory_id === null
    );
  }
  if (filter.query) {
    const q = filter.query.toLowerCase();
    entries = entries.filter((e) => {
      const filenameMatch = (e.file.filename ?? '').toLowerCase().includes(q);
      if (filenameMatch) return true;
      if (filter.include_content) {
        const content = String(e.file.data?.['content'] ?? '').toLowerCase();
        return content.includes(q);
      }
      return false;
    });
  }
  if (filter.view_option === 'created') {
    const kbFiles = await db.knowledgeFile.findMany({ where: { knowledge_id: knowledgeId } });
    const createdBy = new Map(kbFiles.map((k) => [k.file_id, k.user_id]));
    entries = entries.filter((e) => createdBy.get(e.file.id) === userId);
  } else if (filter.view_option === 'shared') {
    const kbFiles = await db.knowledgeFile.findMany({ where: { knowledge_id: knowledgeId } });
    const createdBy = new Map(kbFiles.map((k) => [k.file_id, k.user_id]));
    entries = entries.filter((e) => createdBy.get(e.file.id) !== userId);
  }

  const isAsc = filter.direction === 'asc';
  const orderField = filter.order_by === 'name' ? 'filename' : filter.order_by === 'created_at' ? 'created_at' : 'updated_at';
  entries.sort((a, b) => {
    const av = (a.file as any)[orderField] ?? 0;
    const bv = (b.file as any)[orderField] ?? 0;
    if (av !== bv) return (av > bv ? 1 : -1) * (isAsc ? 1 : -1);
    return a.file.id < b.file.id ? -1 : 1;
  });

  const total = entries.length;
  const page = entries.slice(skip, skip + limit);

  // directories + breadcrumbs + paths
  const allDirs = (await db.knowledgeDirectory.findMany({
    where: { knowledge_id: knowledgeId },
  })) as DirectoryRow[];
  const dirsById = new Map(allDirs.map((d) => [d.id, d]));
  const directoryPath = (dirId: string | null): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    let current = dirId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const d = dirsById.get(current);
      if (!d) break;
      names.push(d.name);
      current = d.parent_id;
    }
    return names.reverse().join('/');
  };
  const scopeDirId = 'directory_id' in filter ? (filter.directory_id ?? null) : null;
  const directories = allDirs
    .filter((d) => (scopeDirId ? d.parent_id === scopeDirId : d.parent_id === null))
    .map(directoryModel);
  const breadcrumbs: any[] = [];
  {
    const seen = new Set<string>();
    let current = scopeDirId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const d = dirsById.get(current);
      if (!d) break;
      breadcrumbs.unshift(directoryModel(d));
      current = d.parent_id;
    }
  }

  const kbFiles = await db.knowledgeFile.findMany({ where: { knowledge_id: knowledgeId } });
  const addedBy = new Map(kbFiles.map((k) => [k.file_id, k.user_id]));
  const userIds = [...new Set([...addedBy.values()])];
  const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } } }) : [];
  const usersById = new Map(users.map((u) => [u.id, u]));

  const items = page.map((e) => ({
    id: e.file.id,
    user_id: e.file.user_id,
    hash: e.file.hash,
    filename: e.file.filename,
    data: stripFileBytesData(e.file.data),
    meta: e.file.meta,
    created_at: e.file.created_at ?? 0,
    updated_at: e.file.updated_at ?? 0,
    directory_id: e.directory_id,
    directory_path: directoryPath(e.directory_id),
    has_original: Boolean(e.file.data?.['content_base64']),
    user: userResponse(addedBy.get(e.file.id) ?? null, usersById),
  }));

  return { items, directories, breadcrumbs, total };
}

// ---------------------------------------------------------------------------
// delete_file_resource + KB cleanup
// ---------------------------------------------------------------------------

async function removeKnowledgeFileRows(knowledgeId: string, fileId: string): Promise<void> {
  await db.knowledgeFile.deleteMany({ where: { knowledge_id: knowledgeId, file_id: fileId } });
}

async function getKnowledgesByFileId(fileId: string): Promise<KnowledgeModel[]> {
  const kbFiles = await db.knowledgeFile.findMany({ where: { file_id: fileId } });
  if (kbFiles.length === 0) return [];
  const rows = (await db.knowledge.findMany({
    where: { id: { in: kbFiles.map((k) => k.knowledge_id) } },
  })) as KnowledgeRow[];
  return Promise.all(rows.map(toKnowledgeModel));
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer (STORED entries — no compression dependency)
// ---------------------------------------------------------------------------

function crc32(buf: Uint8Array): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf-8');
    const data = file.data;
    const crc = crc32(new Uint8Array(data));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // STORED
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // ---- List knowledge bases ----
  {
    method: 'GET',
    path: '',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const page = Math.max(parseInt(ctx.query.get('page') ?? '1', 10) || 1, 1);
      const result = await searchKnowledgeBases(ctx.user!, {}, (page - 1) * PAGE_ITEM_COUNT, PAGE_ITEM_COUNT);
      return ctx.json(result);
    },
  },

  // ---- Search knowledge bases ----
  {
    method: 'GET',
    path: 'search',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const page = Math.max(parseInt(ctx.query.get('page') ?? '1', 10) || 1, 1);
      const filter: KnowledgeFilter = {};
      const query = ctx.query.get('query');
      if (query) filter.query = query;
      const viewOption = ctx.query.get('view_option');
      if (viewOption) filter.view_option = viewOption;
      const source = ctx.query.get('source');
      if (source === 'local' || source === 'external') filter.source = source;
      const orderBy = ctx.query.get('order_by');
      if (orderBy && KNOWLEDGE_SORTABLE_FIELDS.has(orderBy)) filter.order_by = orderBy;
      const direction = ctx.query.get('direction');
      if (direction === 'asc' || direction === 'desc') filter.direction = direction;
      const result = await searchKnowledgeBases(ctx.user!, filter, (page - 1) * PAGE_ITEM_COUNT, PAGE_ITEM_COUNT);
      return ctx.json(result);
    },
  },

  // ---- Search knowledge files (across accessible KBs) ----
  {
    method: 'GET',
    path: 'search/files',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const user = ctx.user!;
      const page = Math.max(parseInt(ctx.query.get('page') ?? '1', 10) || 1, 1);
      const query = ctx.query.get('query') ?? undefined;
      const includeContent = (ctx.query.get('include_content') ?? 'false') === 'true';

      // knowledge bases the user can read
      const accessible = await searchKnowledgeBases(user, {}, 0, Number.MAX_SAFE_INTEGER);
      const knowledgeIds = accessible.items.map((k) => k.id as string);

      let entries: Array<{ file: FileModel; knowledge_id: string; knowledge: any }> = [];
      if (knowledgeIds.length > 0) {
        const kbFiles = await db.knowledgeFile.findMany({
          where: { knowledge_id: { in: knowledgeIds } },
        });
        const rows = (await db.file.findMany({
          where: { id: { in: kbFiles.map((k) => k.file_id) } },
        })) as FileRow[];
        const byId = new Map(rows.map((r) => [r.id, r]));
        const kbById = new Map(accessible.items.map((k) => [k.id as string, k]));
        for (const kbFile of kbFiles) {
          const row = byId.get(kbFile.file_id);
          const kb = kbById.get(kbFile.knowledge_id);
          if (row && kb) entries.push({ file: rowToFileModel(row), knowledge_id: kbFile.knowledge_id, knowledge: kb });
        }
      }

      if (query) {
        const q = query.toLowerCase();
        entries = entries.filter((e) => {
          if ((e.file.filename ?? '').toLowerCase().includes(q)) return true;
          if (includeContent) return String(e.file.data?.['content'] ?? '').toLowerCase().includes(q);
          return false;
        });
      }
      entries.sort((a, b) => {
        const av = a.file.updated_at ?? 0;
        const bv = b.file.updated_at ?? 0;
        if (av !== bv) return av > bv ? -1 : 1;
        return a.file.id < b.file.id ? -1 : 1;
      });
      const total = entries.length;
      const pageEntries = entries.slice((page - 1) * PAGE_ITEM_COUNT, page * PAGE_ITEM_COUNT);
      const userIds = [...new Set(pageEntries.map((e) => e.file.user_id).filter(Boolean) as string[])];
      const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } } }) : [];
      const usersById = new Map(users.map((u) => [u.id, u]));
      return ctx.json({
        items: pageEntries.map((e) => ({
          id: e.file.id,
          user_id: e.file.user_id,
          hash: e.file.hash,
          filename: e.file.filename,
          data: stripFileBytesData(e.file.data),
          meta: e.file.meta,
          created_at: e.file.created_at ?? 0,
          updated_at: e.file.updated_at ?? 0,
          user: userResponse(e.file.user_id, usersById),
          collection: e.knowledge,
        })),
        total,
      });
    },
  },

  // ---- Create knowledge ----
  {
    method: 'POST',
    path: 'create',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const user = ctx.user!;
      const form = await ctx.body<{ name?: string; description?: string; access_grants?: any[] }>();
      if (!form?.name) return ctx.error(422, 'Name is required');

      const defaultPermissions = await configGet<any>('user.permissions', DEFAULT_USER_PERMISSIONS);
      const { hasPermission } = await import('@/lib/access-control');
      if (user.role !== 'admin' && !(await hasPermission(user.id, 'workspace.knowledge', defaultPermissions))) {
        return ctx.error(401, ERROR_MESSAGES.UNAUTHORIZED);
      }

      const accessGrants = await filterAllowedAccessGrants(user.id, user.role, form.access_grants ?? []);

      const id = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      await db.knowledge.create({
        data: {
          id,
          user_id: user.id,
          name: form.name,
          description: form.description ?? '',
          meta: JSON.stringify({}),
          created_at: now,
          updated_at: now,
        },
      });
      await setAccessGrants('knowledge', id, accessGrants as any[]);

      const knowledge = await getKnowledgeById(id);
      if (knowledge) {
        await embedKnowledgeBaseMetadata(knowledge.id, knowledge.name, knowledge.description);
        return ctx.json(knowledgeResponse(knowledge, null));
      }
      return ctx.error(400, 'Uh-oh! This file is already registered. Please choose another file.');
    },
  },

  // ---- Reindex knowledge files (admin) ----
  {
    method: 'POST',
    path: 'reindex',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const user = ctx.user!;
      if (user.role !== 'admin') return ctx.error(401, ERROR_MESSAGES.UNAUTHORIZED);
      const rows = (await db.knowledge.findMany({})) as KnowledgeRow[];
      for (const row of rows) {
        try {
          await deleteChunksForCollection(row.id);
          const files = await getFilesWithDirectoryIds(row.id);
          for (const { file } of files) {
            try {
              // force re-extraction: drop stale file-{id} chunks first
              await deleteChunksForCollection(`file-${file.id}`);
              await indexFile(user, { file_id: file.id, collection_name: row.id });
            } catch (e) {
              console.error(`Error processing file ${file.filename} (ID: ${file.id}): ${e}`);
            }
          }
        } catch (e) {
          console.error(`Error processing knowledge base ${row.id}: ${e}`);
        }
      }
      return ctx.json(true);
    },
  },

  // ---- Reindex knowledge metadata embeddings (admin) ----
  {
    method: 'POST',
    path: 'metadata/reindex',
    auth: 'admin',
    handler: async (ctx: Ctx) => {
      await deleteChunksForCollection(KNOWLEDGE_BASES_COLLECTION);
      const rows = (await db.knowledge.findMany({})) as KnowledgeRow[];
      let success = 0;
      for (const row of rows) {
        if (await embedKnowledgeBaseMetadata(row.id, row.name ?? '', row.description ?? '')) {
          success++;
        }
      }
      return ctx.json({ total: rows.length, success });
    },
  },

  // ---- Get knowledge by id ----
  {
    method: 'GET',
    path: ':id',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const knowledge = await getKnowledgeById(ctx.params.id);
      if (!knowledge) return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      const user = ctx.user!;
      if (
        user.role === 'admin' ||
        knowledge.user_id === user.id ||
        (await hasAccessGrant(user.id, 'knowledge', knowledge.id, 'read'))
      ) {
        const writeAccess =
          user.id === knowledge.user_id ||
          (user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL) ||
          (await hasAccessGrant(user.id, 'knowledge', knowledge.id, 'write'));
        return ctx.json({ ...knowledgeResponse(knowledge, null), write_access: writeAccess });
      }
      return ctx.error(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
    },
  },

  // ---- Update knowledge ----
  {
    method: 'POST',
    path: ':id/update',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const user = ctx.user!;
      const knowledge = await getKnowledgeById(id);
      if (!knowledge) return ctx.error(400, ERROR_MESSAGES.NOT_FOUND);
      if (!(await canManageKnowledge(knowledge, user))) {
        return ctx.error(400, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }
      const form = await ctx.body<{ name?: string; description?: string }>();
      await db.knowledge.update({
        where: { id },
        data: {
          ...(form?.name !== undefined ? { name: form.name } : {}),
          ...(form?.description !== undefined ? { description: form.description } : {}),
          updated_at: Math.floor(Date.now() / 1000),
        },
      });
      const updated = await getKnowledgeById(id);
      if (updated) {
        await embedKnowledgeBaseMetadata(updated.id, updated.name, updated.description);
        return ctx.json({ ...knowledgeResponse(updated, []), write_access: true });
      }
      return ctx.error(400, 'Uh-oh! This id is already registered. Please choose another id string.');
    },
  },

  // ---- Update knowledge access grants ----
  {
    method: 'POST',
    path: ':id/access/update',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const user = ctx.user!;
      const knowledge = await getKnowledgeById(id);
      if (!knowledge) return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      if (!(await canManageKnowledge(knowledge, user))) {
        return ctx.error(400, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }
      const form = await ctx.body<{ access_grants?: any[] }>();
      const grants = await setAccessGrants('knowledge', id, form?.access_grants ?? []);
      const updated = await getKnowledgeById(id);
      return ctx.json({
        ...knowledgeResponse(updated ?? knowledge, []),
        access_grants: grants,
      });
    },
  },

  // ---- Pending knowledge files ----
  {
    method: 'GET',
    path: ':id/files/pending',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const user = ctx.user!;
      const knowledge = await getKnowledgeById(id);
      if (!knowledge) return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      if (
        !(
          user.role === 'admin' ||
          knowledge.user_id === user.id ||
          (await hasAccessGrant(user.id, 'knowledge', knowledge.id, 'read'))
        )
      ) {
        return ctx.error(400, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }
      // stream=true SSE omitted (serverless) — non-stream list parity
      const linked = await db.knowledgeFile.findMany({ where: { knowledge_id: id } });
      const linkedIds = new Set(linked.map((l) => l.file_id));
      const rows = (await db.file.findMany({})) as FileRow[];
      const pending = rows
        .filter((r) => {
          const meta = safeJson(r.meta) ?? {};
          const data = safeJson(r.data) ?? {};
          return (
            (meta['data'] as any)?.['knowledge_id'] === id &&
            ['pending', 'processing'].includes(String(data['status'])) &&
            !linkedIds.has(r.id)
          );
        })
        .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
      return ctx.json(pending.map((r) => fileMetadataResponse(rowToFileModel(r))));
    },
  },

  // ---- Knowledge files list ----
  {
    method: 'GET',
    path: ':id/files',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const user = ctx.user!;
      const knowledge = await getKnowledgeById(id);
      if (!knowledge) return ctx.error(400, ERROR_MESSAGES.NOT_FOUND);
      if (
        !(
          user.role === 'admin' ||
          knowledge.user_id === user.id ||
          (await hasAccessGrant(user.id, 'knowledge', knowledge.id, 'read'))
        )
      ) {
        return ctx.error(400, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }
      const page = Math.max(parseInt(ctx.query.get('page') ?? '1', 10) || 1, 1);
      let limit: number;
      const limitParam = ctx.query.get('limit');
      if (user.role === 'admin' && limitParam !== null) {
        limit = Math.max(parseInt(limitParam, 10) || 1, 1);
      } else {
        limit = PAGE_ITEM_COUNT;
      }
      const filter: any = {};
      const query = ctx.query.get('query');
      if (query) filter.query = query;
      if ((ctx.query.get('include_content') ?? 'false') === 'true') filter.include_content = true;
      const viewOption = ctx.query.get('view_option');
      if (viewOption) filter.view_option = viewOption;
      const orderBy = ctx.query.get('order_by');
      if (orderBy) filter.order_by = orderBy;
      const direction = ctx.query.get('direction');
      if (direction) filter.direction = direction;
      const directoryId = ctx.query.get('directory_id');
      if (directoryId !== null) filter.directory_id = directoryId || null;

      return ctx.json(await getKnowledgeFilesList(id, user.id, filter, (page - 1) * limit, limit));
    },
  },

  // ---- Add file to knowledge ----
  {
    method: 'POST',
    path: ':id/file/add',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const user = ctx.user!;
      const knowledge = await getKnowledgeById(id);
      if (!knowledge) return ctx.error(400, ERROR_MESSAGES.NOT_FOUND);
      if (isExternalKnowledge(knowledge)) externalKnowledgeError();
      if (!(await canManageKnowledge(knowledge, user))) {
        return ctx.error(400, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const form = await ctx.body<{ file_id?: string; directory_id?: string | null }>();
      const fileId = form?.file_id;
      if (!fileId) return ctx.error(422, 'file_id is required');
      if (form?.directory_id) {
        const dir = await db.knowledgeDirectory.findUnique({ where: { id: form.directory_id } });
        if (!dir || dir.knowledge_id !== id) {
          return ctx.error(404, 'Target directory not found.');
        }
      }

      const file = await getFileById(fileId);
      if (!file) return ctx.error(400, ERROR_MESSAGES.NOT_FOUND);
      if (!file.data) return ctx.error(400, RAG_ERRORS.FILE_NOT_PROCESSED);

      if (file.user_id !== user.id && user.role !== 'admin') {
        if (!(await hasAccessToFile(file.id, 'read', user))) {
          return ctx.error(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
        }
      }

      try {
        await indexFile(user, { file_id: fileId, collection_name: id });
        const now = Math.floor(Date.now() / 1000);
        const existing = await db.knowledgeFile.findFirst({
          where: { knowledge_id: id, file_id: fileId },
        });
        if (!existing) {
          await db.knowledgeFile.create({
            data: {
              id: crypto.randomUUID(),
              knowledge_id: id,
              file_id: fileId,
              directory_id: form?.directory_id ?? null,
              user_id: user.id,
              created_at: now,
              updated_at: now,
            },
          });
        }
      } catch (e) {
        const detail = e instanceof HttpError ? e.detail : e instanceof Error ? e.message : String(e);
        return ctx.error(400, detail);
      }

      const updatedFile = await getFileById(fileId);
      return ctx.json({
        ...knowledgeResponse(knowledge, updatedFile ? [fileMetadataResponse(updatedFile)] : []),
        write_access: true,
      });
    },
  },

  // ---- Update file in knowledge (reindex) ----
  {
    method: 'POST',
    path: ':id/file/update',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const user = ctx.user!;
      const knowledge = await getKnowledgeById(id);
      if (!knowledge) return ctx.error(400, ERROR_MESSAGES.NOT_FOUND);
      if (isExternalKnowledge(knowledge)) externalKnowledgeError();
      if (!(await canManageKnowledge(knowledge, user))) {
        return ctx.error(400, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const form = await ctx.body<{ file_id?: string }>();
      const fileId = form?.file_id;
      if (!fileId) return ctx.error(422, 'file_id is required');
      const file = await getFileById(fileId);
      if (!file) return ctx.error(400, ERROR_MESSAGES.NOT_FOUND);

      const linked = await db.knowledgeFile.findFirst({ where: { knowledge_id: id, file_id: fileId } });
      if (!linked) return ctx.error(400, ERROR_MESSAGES.NOT_FOUND);

      await deleteChunksForFileInCollection(id, fileId);

      try {
        await indexFile(user, { file_id: fileId, collection_name: id });
      } catch (e) {
        const detail = e instanceof HttpError ? e.detail : e instanceof Error ? e.message : String(e);
        return ctx.error(400, detail);
      }

      const updatedFile = await getFileById(fileId);
      return ctx.json({
        ...knowledgeResponse(knowledge, updatedFile ? [fileMetadataResponse(updatedFile)] : []),
        write_access: true,
      });
    },
  },

  // ---- Remove file from knowledge ----
  {
    method: 'POST',
    path: ':id/file/remove',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const user = ctx.user!;
      const knowledge = await getKnowledgeById(id);
      if (!knowledge) return ctx.error(400, ERROR_MESSAGES.NOT_FOUND);
      if (isExternalKnowledge(knowledge)) externalKnowledgeError();
      if (!(await canManageKnowledge(knowledge, user))) {
        return ctx.error(400, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const form = await ctx.body<{ file_id?: string }>();
      const fileId = form?.file_id;
      if (!fileId) return ctx.error(422, 'file_id is required');
      const file = await getFileById(fileId);
      if (!file) return ctx.error(400, ERROR_MESSAGES.NOT_FOUND);

      const linked = await db.knowledgeFile.findFirst({ where: { knowledge_id: id, file_id: fileId } });
      if (!linked) return ctx.error(400, ERROR_MESSAGES.NOT_FOUND);

      await removeKnowledgeFileRows(id, fileId);
      try {
        await deleteChunksForFileInCollection(id, fileId);
      } catch (e) {
        console.debug(`KB embedding cleanup for ${id}: ${e}`);
      }

      const deleteFileParam = ctx.query.get('delete_file');
      const deleteFile = deleteFileParam === null ? !ENABLE_KNOWLEDGE_FILE_RETENTION : deleteFileParam !== 'false';
      if (deleteFile && (file.user_id === user.id || user.role === 'admin')) {
        await deleteFileResource(file);
      }

      return ctx.json({ ...knowledgeResponse(knowledge, []), write_access: true });
    },
  },

  // ---- Move file within knowledge ----
  {
    method: 'POST',
    path: ':id/file/move',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const user = ctx.user!;
      await verifyKnowledgeWriteAccess(id, user);
      const form = await ctx.body<{ file_id?: string; directory_id?: string | null }>();
      const fileId = form?.file_id;
      if (!fileId) return ctx.error(422, 'file_id is required');
      const linked = await db.knowledgeFile.findFirst({ where: { knowledge_id: id, file_id: fileId } });
      if (!linked) return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);

      if (form?.directory_id) {
        const dir = await db.knowledgeDirectory.findUnique({ where: { id: form.directory_id } });
        if (!dir || dir.knowledge_id !== id) {
          return ctx.error(404, 'Target directory not found.');
        }
      }

      const success = await db.knowledgeFile
        .update({
          where: { id: linked.id },
          data: { directory_id: form?.directory_id ?? null, updated_at: Math.floor(Date.now() / 1000) },
        })
        .then(() => true)
        .catch(() => false);
      if (!success) return ctx.error(500, 'Failed to move file.');
      return ctx.json({ status: true });
    },
  },

  // ---- Delete knowledge ----
  {
    method: 'DELETE',
    path: ':id/delete',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const user = ctx.user!;
      const knowledge = await getKnowledgeById(id);
      if (!knowledge) return ctx.error(400, ERROR_MESSAGES.NOT_FOUND);
      if (!(await canManageKnowledge(knowledge, user))) {
        return ctx.error(400, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      // Update models that reference this knowledge base
      const models = await db.model.findMany({});
      for (const model of models) {
        const meta = safeJson<any>(model.meta) ?? {};
        const knowledgeList = Array.isArray(meta['knowledge']) ? meta['knowledge'] : null;
        if (knowledgeList) {
          const updated = knowledgeList.filter((k: any) => k?.['id'] !== id);
          if (updated.length !== knowledgeList.length) {
            await db.model.update({
              where: { id: model.id },
              data: { meta: JSON.stringify({ ...meta, knowledge: updated }) },
            });
          }
        }
      }

      // Clean up vector DB
      if (!isExternalKnowledge(knowledge)) {
        try {
          await deleteChunksForCollection(id);
        } catch (e) {
          console.debug(e);
        }
      }
      await removeKnowledgeBaseMetadataEmbedding(id);

      const result = await db.knowledge
        .delete({ where: { id } })
        .then(() => true)
        .catch(() => false);
      await db.knowledgeFile.deleteMany({ where: { knowledge_id: id } });
      await db.knowledgeDirectory.deleteMany({ where: { knowledge_id: id } });
      await db.accessGrant.deleteMany({ where: { resource_type: 'knowledge', resource_id: id } });
      return ctx.json(result);
    },
  },

  // ---- Reset knowledge ----
  {
    method: 'POST',
    path: ':id/reset',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const user = ctx.user!;
      const knowledge = await getKnowledgeById(id);
      if (!knowledge) return ctx.error(400, ERROR_MESSAGES.NOT_FOUND);
      if (isExternalKnowledge(knowledge)) externalKnowledgeError();
      if (!(await canManageKnowledge(knowledge, user))) {
        return ctx.error(400, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const includeDirectories = (ctx.query.get('include_directories') ?? 'true') !== 'false';
      const files = ENABLE_KNOWLEDGE_FILE_RETENTION
        ? []
        : (await getFilesWithDirectoryIds(id)).map((e) => e.file);

      try {
        await deleteChunksForCollection(id);
      } catch (e) {
        console.debug(e);
      }

      for (const file of files) {
        if (file.user_id === user.id || user.role === 'admin') {
          await deleteFileResource(file);
        }
      }

      await db.knowledgeFile.deleteMany({ where: { knowledge_id: id } });
      if (includeDirectories) {
        await db.knowledgeDirectory.deleteMany({ where: { knowledge_id: id } });
      }
      await db.knowledge.update({
        where: { id },
        data: { updated_at: Math.floor(Date.now() / 1000) },
      });
      return ctx.json(knowledgeResponse((await getKnowledgeById(id)) as KnowledgeModel));
    },
  },

  // ---- Sync diff ----
  {
    method: 'POST',
    path: ':id/sync/diff',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const user = ctx.user!;
      await verifyKnowledgeWriteAccess(id, user);

      const form = await ctx.body<{
        manifest?: Array<{ filename: string; path: string; checksum: string; size?: number }>;
      }>();
      const manifest = form?.manifest ?? [];

      const existingDirectories = (await db.knowledgeDirectory.findMany({
        where: { knowledge_id: id },
      })) as DirectoryRow[];

      const directoryPathById = new Map<string, string>();
      const directoryIdByPath = new Map<string, string>();
      for (const directory of existingDirectories) {
        const segments = [directory.name];
        let parentId = directory.parent_id;
        while (parentId) {
          const parent = existingDirectories.find((d) => d.id === parentId);
          if (!parent) break;
          segments.unshift(parent.name);
          parentId = parent.parent_id;
        }
        const fullPath = segments.join('/');
        directoryPathById.set(directory.id, fullPath);
        directoryIdByPath.set(fullPath, directory.id);
      }

      // pending uploads within the last hour
      const linked = await db.knowledgeFile.findMany({ where: { knowledge_id: id } });
      const linkedIds = new Set(linked.map((l) => l.file_id));
      const allFiles = (await db.file.findMany({})) as FileRow[];
      const pendingFiles = new Set<string>(); // `${path}|${filename}|${file_hash}`
      for (const row of allFiles) {
        if (linkedIds.has(row.id)) continue;
        const meta = safeJson<any>(row.meta) ?? {};
        const data = safeJson(row.data) ?? {};
        if (
          meta['data']?.['knowledge_id'] === id &&
          ['pending', 'processing'].includes(String(data['status'])) &&
          (row.created_at ?? 0) >= Math.floor(Date.now() / 1000) - 3600
        ) {
          const dirPath = directoryPathById.get(meta['data']?.['directory_id'] ?? '') ?? '';
          pendingFiles.add(`${dirPath}|${row.filename ?? ''}|${String(meta['file_hash'] ?? '')}`);
        }
      }

      const knowledgeFiles = await getFilesWithDirectoryIds(id);
      const indexedFiles = new Map<string, { file_id: string; checksum: string | null }>();
      for (const { file, directory_id } of knowledgeFiles) {
        const filePath = directory_id ? directoryPathById.get(directory_id) ?? '' : '';
        indexedFiles.set(`${filePath}|${file.filename ?? ''}`, {
          file_id: file.id,
          checksum: (file.meta?.['file_hash'] as string) ?? null,
        });
      }

      const added: any[] = [];
      const modified: any[] = [];
      const deleted: any[] = [];
      let unmodifiedCount = 0;
      const manifestKeys = new Set<string>();
      for (const entry of manifest) {
        const key = `${entry.path ?? ''}|${entry.filename}`;
        manifestKeys.add(key);
        if (!indexedFiles.has(key) && pendingFiles.has(`${entry.path ?? ''}|${entry.filename}|${entry.checksum}`)) {
          unmodifiedCount++;
          continue;
        }
        if (!indexedFiles.has(key)) {
          added.push({ filename: entry.filename, path: entry.path ?? '' });
        } else if (indexedFiles.get(key)!.checksum !== entry.checksum) {
          modified.push({
            filename: entry.filename,
            path: entry.path ?? '',
            stale_file_id: indexedFiles.get(key)!.file_id,
          });
        } else {
          unmodifiedCount++;
        }
      }
      for (const [key, info] of indexedFiles) {
        if (!manifestKeys.has(key)) {
          deleted.push({ file_id: info.file_id, filename: key.split('|').pop() ?? '' });
        }
      }

      const requiredDirectoryPaths = new Set<string>();
      for (const entry of manifest) {
        if (entry.path) {
          const segments = entry.path.split('/');
          for (let depth = 0; depth < segments.length; depth++) {
            requiredDirectoryPaths.add(segments.slice(0, depth + 1).join('/'));
          }
        }
      }
      const mkdir = [...requiredDirectoryPaths]
        .filter((p) => !directoryIdByPath.has(p))
        .sort((a, b) => a.split('/').length - b.split('/').length);
      const rmdir = [...new Set([...directoryIdByPath.keys()])]
        .filter((p) => !requiredDirectoryPaths.has(p))
        .map((p) => directoryIdByPath.get(p)!);

      return ctx.json({
        added,
        modified,
        deleted,
        mkdir,
        rmdir,
        unmodified_count: unmodifiedCount,
        directory_map: Object.fromEntries(directoryIdByPath),
      });
    },
  },

  // ---- Sync cleanup ----
  {
    method: 'POST',
    path: ':id/sync/cleanup',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const user = ctx.user!;
      await verifyKnowledgeWriteAccess(id, user);

      const form = await ctx.body<{ file_ids?: string[]; dir_ids?: string[] }>();
      for (const fileId of form?.file_ids ?? []) {
        const file = await getFileById(fileId);
        if (!file) continue;
        const linked = await db.knowledgeFile.findFirst({ where: { knowledge_id: id, file_id: fileId } });
        if (!linked) continue;

        await removeKnowledgeFileRows(id, fileId);
        try {
          await deleteChunksForFileInCollection(id, fileId);
        } catch {
          /* ignore */
        }
        const linkedKnowledges = await getKnowledgesByFileId(fileId);
        if (
          !ENABLE_KNOWLEDGE_FILE_RETENTION &&
          linkedKnowledges.length === 0 &&
          (file.user_id === user.id || user.role === 'admin')
        ) {
          await deleteFileResource(file);
        }
      }

      for (const dirId of [...(form?.dir_ids ?? [])].reverse()) {
        const directory = await db.knowledgeDirectory.findUnique({ where: { id: dirId } });
        if (!directory || directory.knowledge_id !== id) continue;
        // delete the subtree (children before parents)
        const allDirs = (await db.knowledgeDirectory.findMany({
          where: { knowledge_id: id },
        })) as DirectoryRow[];
        const subtree = new Set<string>([dirId]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const d of allDirs) {
            if (d.parent_id && subtree.has(d.parent_id) && !subtree.has(d.id)) {
              subtree.add(d.id);
              changed = true;
            }
          }
        }
        await db.knowledgeFile.deleteMany({ where: { directory_id: { in: [...subtree] } } });
        await db.knowledgeDirectory.deleteMany({ where: { id: { in: [...subtree] } } });
      }

      return ctx.json({ status: true });
    },
  },

  // ---- Batch add files ----
  {
    method: 'POST',
    path: ':id/files/batch/add',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const user = ctx.user!;
      const knowledge = await getKnowledgeById(id);
      if (!knowledge) return ctx.error(400, ERROR_MESSAGES.NOT_FOUND);
      if (isExternalKnowledge(knowledge)) externalKnowledgeError();
      if (!(await canManageKnowledge(knowledge, user))) {
        return ctx.error(400, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const formData = await ctx.body<
        Array<{ file_id: string; directory_id?: string | null }>
      >();
      const formList: Array<{ file_id: string; directory_id?: string | null }> = Array.isArray(formData)
        ? formData
        : [];
      for (const directoryId of new Set(formList.map((f) => f.directory_id).filter(Boolean) as string[])) {
        const dir = await db.knowledgeDirectory.findUnique({ where: { id: directoryId } });
        if (!dir || dir.knowledge_id !== id) {
          return ctx.error(404, 'Target directory not found.');
        }
      }

      const fileIds = formList.map((f) => f.file_id);
      const files = await Promise.all(fileIds.map((fid) => getFileById(fid)));
      const missing = fileIds.filter((fid, i) => !files[i]);
      if (missing.length > 0) {
        return ctx.error(400, `File ${missing[0]} not found`);
      }

      // Per-file read-access check
      if (user.role !== 'admin') {
        for (const file of files) {
          if (file && file.user_id !== user.id && !(await hasAccessToFile(file.id, 'read', user))) {
            return ctx.error(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
          }
        }
      }

      // Filter out files already linked (issue #10679)
      const newEntries: Array<{ file_id: string; directory_id?: string | null }> = [];
      for (const form of formList) {
        const linked = await db.knowledgeFile.findFirst({ where: { knowledge_id: id, file_id: form.file_id } });
        if (!linked) newEntries.push(form);
      }
      if (newEntries.length === 0) {
        return ctx.json({ ...knowledgeResponse(knowledge, []), write_access: true });
      }

      const { processFilesBatch } = await import('./retrieval');
      const result = await processFilesBatch(user, {
        files: newEntries
          .map((form) => files.find((f) => f!.id === form.file_id)!)
          .filter(Boolean),
        collection_name: id,
      });

      const successfulFileIds = result.results.filter((r) => r.status === 'completed').map((r) => r.file_id);
      const dirMap = new Map(newEntries.map((f) => [f.file_id, f.directory_id ?? null]));
      const now = Math.floor(Date.now() / 1000);
      for (const fileId of successfulFileIds) {
        const existing = await db.knowledgeFile.findFirst({ where: { knowledge_id: id, file_id: fileId } });
        if (!existing) {
          await db.knowledgeFile.create({
            data: {
              id: crypto.randomUUID(),
              knowledge_id: id,
              file_id: fileId,
              directory_id: dirMap.get(fileId) ?? null,
              user_id: user.id,
              created_at: now,
              updated_at: now,
            },
          });
        }
      }

      const updatedFiles = await Promise.all(successfulFileIds.map((fid) => getFileById(fid)));
      if (result.errors.length > 0) {
        return ctx.json({
          ...knowledgeResponse(knowledge, updatedFiles.filter(Boolean).map((f) => fileMetadataResponse(f!))),
          write_access: true,
          warnings: {
            message: 'Some files failed to process',
            errors: result.errors.map((err) => `${err.file_id}: ${err.error}`),
          },
        });
      }
      return ctx.json({
        ...knowledgeResponse(knowledge, updatedFiles.filter(Boolean).map((f) => fileMetadataResponse(f!))),
        write_access: true,
      });
    },
  },

  // ---- Export knowledge (admin) ----
  {
    method: 'GET',
    path: ':id/export',
    auth: 'admin',
    handler: async (ctx: Ctx) => {
      const knowledge = await getKnowledgeById(ctx.params.id);
      if (!knowledge) return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);
      if (isExternalKnowledge(knowledge)) externalKnowledgeError();

      const entries = await getFilesWithDirectoryIds(knowledge.id);
      const zipFiles: Array<{ name: string; data: Buffer }> = [];
      for (const { file } of entries) {
        const content = String(file.data?.['content'] ?? '');
        if (content) {
          let filename = file.filename ?? 'file';
          if (!filename.endsWith('.txt')) filename = `${filename}.txt`;
          zipFiles.push({ name: filename, data: Buffer.from(content, 'utf-8') });
        }
      }
      const zip = createZip(zipFiles);
      const safeName = (knowledge.name ?? 'knowledge').replace(/[^a-zA-Z0-9 -_]/g, '_');
      return new Response(new Uint8Array(zip), {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${safeName}.zip`)}`,
        },
      });
    },
  },

  // ---- Directories ----
  {
    method: 'POST',
    path: ':id/dirs/create',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const user = ctx.user!;
      await verifyKnowledgeWriteAccess(id, user);
      const form = await ctx.body<{ name?: string; parent_id?: string | null }>();
      if (!form?.name) return ctx.error(422, 'Name is required');
      if (form.parent_id) {
        const parent = await db.knowledgeDirectory.findUnique({ where: { id: form.parent_id } });
        if (!parent || parent.knowledge_id !== id) {
          return ctx.error(404, 'Parent directory not found.');
        }
      }
      const now = Math.floor(Date.now() / 1000);
      const directory = await db.knowledgeDirectory
        .create({
          data: {
            id: crypto.randomUUID(),
            knowledge_id: id,
            parent_id: form.parent_id ?? null,
            name: form.name,
            user_id: user.id,
            created_at: now,
            updated_at: now,
          },
        })
        .catch(() => null);
      if (!directory) {
        return ctx.error(
          400,
          'Failed to create directory. A directory with this name may already exist at this level.'
        );
      }
      return ctx.json(directoryModel(directory as DirectoryRow));
    },
  },
  {
    method: 'POST',
    path: ':id/dirs/:dir_id/update',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const dirId = ctx.params.dir_id;
      const user = ctx.user!;
      await verifyKnowledgeWriteAccess(id, user);
      const dir = await db.knowledgeDirectory.findUnique({ where: { id: dirId } });
      if (!dir || dir.knowledge_id !== id) return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);

      const form = await ctx.body<{ name?: string | null; parent_id?: string | null }>();
      if (form?.parent_id && form.parent_id !== '__unset__') {
        const parent = await db.knowledgeDirectory.findUnique({ where: { id: form.parent_id } });
        if (!parent || parent.knowledge_id !== id) {
          return ctx.error(404, 'Parent directory not found.');
        }
      }
      const updated = await db.knowledgeDirectory
        .update({
          where: { id: dirId },
          data: {
            ...(form?.name ? { name: form.name } : {}),
            ...(form?.parent_id !== undefined && form.parent_id !== '__unset__'
              ? { parent_id: form.parent_id ?? null }
              : {}),
            updated_at: Math.floor(Date.now() / 1000),
          },
        })
        .catch(() => null);
      if (!updated) {
        return ctx.error(
          400,
          'Failed to update directory. This may be caused by a naming conflict or circular move.'
        );
      }
      return ctx.json(directoryModel(updated as DirectoryRow));
    },
  },
  {
    method: 'DELETE',
    path: ':id/dirs/:dir_id/delete',
    auth: 'user',
    handler: async (ctx: Ctx) => {
      const id = ctx.params.id;
      const dirId = ctx.params.dir_id;
      const user = ctx.user!;
      await verifyKnowledgeWriteAccess(id, user);
      const dir = await db.knowledgeDirectory.findUnique({ where: { id: dirId } });
      if (!dir || dir.knowledge_id !== id) return ctx.error(404, ERROR_MESSAGES.NOT_FOUND);

      const moveFiles = (ctx.query.get('move_files') ?? 'true') !== 'false';

      // collect the subtree
      const allDirs = (await db.knowledgeDirectory.findMany({
        where: { knowledge_id: id },
      })) as DirectoryRow[];
      const subtree = new Set<string>([dirId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const d of allDirs) {
          if (d.parent_id && subtree.has(d.parent_id) && !subtree.has(d.id)) {
            subtree.add(d.id);
            changed = true;
          }
        }
      }

      const subtreeFiles = await db.knowledgeFile.findMany({
        where: { directory_id: { in: [...subtree] } },
      });
      const files = moveFiles
        ? []
        : (await Promise.all(subtreeFiles.map((f) => getFileById(f.file_id)))).filter(Boolean) as FileModel[];

      if (moveFiles) {
        await db.knowledgeFile.updateMany({
          where: { directory_id: { in: [...subtree] } },
          data: { directory_id: dir.parent_id ?? null, updated_at: Math.floor(Date.now() / 1000) },
        });
      } else {
        await db.knowledgeFile.deleteMany({ where: { directory_id: { in: [...subtree] } } });
      }
      // child directories move up with move_files, otherwise removed with the subtree
      if (moveFiles) {
        await db.knowledgeDirectory.updateMany({
          where: { parent_id: dirId },
          data: { parent_id: dir.parent_id ?? null },
        });
        await db.knowledgeDirectory.delete({ where: { id: dirId } }).catch(() => null);
      } else {
        await db.knowledgeDirectory.deleteMany({ where: { id: { in: [...subtree] } } });
      }

      for (const file of files) {
        try {
          await deleteChunksForFileInCollection(id, file.id);
        } catch (e) {
          console.debug(`KB embedding cleanup for ${id}: ${e}`);
        }
        if (!ENABLE_KNOWLEDGE_FILE_RETENTION) {
          const linkedKnowledges = await getKnowledgesByFileId(file.id);
          if (linkedKnowledges.length === 0 && (file.user_id === user.id || user.role === 'admin')) {
            await deleteFileResource(file);
          }
        }
      }

      return ctx.json({ status: true, file_ids: files.map((f) => f.id) });
    },
  },
];
