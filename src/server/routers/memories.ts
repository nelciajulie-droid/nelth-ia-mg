import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { configGet } from '@/lib/config';
import { ERROR_MESSAGES, env } from '@/lib/constants';
import { hasPermission } from '@/lib/access-control';
import { generateEmbedding, cosineSimilarity } from '@/lib/retrieval/embeddings';
import { EM } from '@/lib/models/workspace';

/**
 * Port of open_webui/routers/memories.py (/api/v1/memories).
 *
 * Deviation (documented): Python stores memory embeddings in the external
 * vector DB (Chroma et al.) under collection `user-memory-{user_id}`. This
 * port reuses the serverless `chunk` table (the TS vector-store replacement)
 * with the same collection naming; cosine similarity is computed in JS.
 */

type MemoryRow = {
  id: string;
  user_id: string | null;
  type: string | null;
  path: string | null;
  content: string | null;
  meta: string | null;
  updated_at: number | null;
  created_at: number | null;
};

type MemoryModel = {
  id: string;
  user_id: string;
  type: 'user' | 'context';
  path: string | null;
  content: string;
  meta: Record<string, any> | null;
  updated_at: number;
  created_at: number;
};

function err(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

function requireUser(ctx: Ctx) {
  const user = ctx.user;
  if (!user) err(401, ERROR_MESSAGES.NOT_AUTHENTICATED);
  return user;
}

function rowToModel(row: MemoryRow): MemoryModel {
  let meta: Record<string, any> | null = null;
  if (row.meta) {
    try {
      meta = JSON.parse(row.meta);
    } catch {
      meta = null;
    }
  }
  return {
    id: row.id,
    user_id: row.user_id ?? '',
    type: row.type === 'user' ? 'user' : 'context',
    path: row.path ?? null,
    content: row.content ?? '',
    meta,
    updated_at: row.updated_at ?? 0,
    created_at: row.created_at ?? 0,
  };
}

// ---------------------------------------------------------------------------
// utils/memory.py ports
// ---------------------------------------------------------------------------

function cleanMemoryContent(content: string | null | undefined): string {
  const value = (content ?? '').trim();
  if (!value) err(400, 'Memory content cannot be empty');
  return value;
}

function cleanMemoryPath(path: string | null | undefined): string | null {
  const value = (path ?? '').trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
  if (!value) return null;
  const parts = value.split('/');
  if (parts.some((part) => ['', '.', '..'].includes(part)) || [...value].some((ch) => ch.charCodeAt(0) < 32)) {
    err(400, 'Invalid memory path');
  }
  return value;
}

function memoryVectorText(content: string | null | undefined, path: string | null | undefined): string {
  const p = cleanMemoryPath(path);
  return p ? `${p}\n${content ?? ''}` : (content ?? '');
}

function pathParts(path: string | null | undefined): string[] {
  return (path ?? '').split('/').filter(Boolean);
}

function parentPath(path: string | null | undefined): string | null {
  const parts = pathParts(path);
  return parts.length > 1 ? parts.slice(0, -1).join('/') : null;
}

function pathRank(memoryPath: string | null, lookupPath: string | null): [number, number] | null {
  if (!lookupPath) return null;
  const mp = cleanMemoryPath(memoryPath);
  const lp = cleanMemoryPath(lookupPath);
  if (!mp || !lp) return null;
  if (mp === lp) return [0, 0];
  if (mp.startsWith(`${lp}/`)) return [1, pathParts(mp).length - pathParts(lp).length];
  if (lp.startsWith(`${mp}/`)) return [2, pathParts(lp).length - pathParts(mp).length];
  if (parentPath(mp) && parentPath(mp) === parentPath(lp)) return [3, 0];
  const shared = new Set(pathParts(mp)).size + new Set(pathParts(lp)).size;
  const sharedCount = pathParts(mp).filter((p) => new Set(pathParts(lp)).has(p)).length;
  void shared;
  if (sharedCount) return [4, -sharedCount];
  const mpParts = pathParts(mp);
  const lpParts = pathParts(lp);
  if (mpParts[mpParts.length - 1] === lpParts[lpParts.length - 1]) return [5, 0];
  return null;
}

function memoryMatchesQuery(memory: MemoryModel, query: string): boolean {
  const value = query.trim().toLowerCase();
  if (!value) return true;
  return (
    (memory.content ?? '').toLowerCase().includes(value) ||
    (memory.path ?? '').toLowerCase().includes(value)
  );
}

function searchMemoryRows(
  memories: MemoryModel[],
  opts: {
    query?: string | null;
    path?: string | null;
    memoryId?: string | null;
    memoryType?: string;
    limit?: number;
  }
): MemoryModel[] {
  let rows = [...(memories ?? [])];
  const { query, path, memoryId, memoryType = 'all', limit = 20 } = opts;
  if (memoryId) rows = rows.filter((m) => m.id === memoryId);
  if (memoryType !== 'all') rows = rows.filter((m) => m.type === memoryType);

  const q = (query ?? '').trim();
  const lookupPath = cleanMemoryPath(path);
  if (lookupPath) {
    const basename = pathParts(lookupPath).pop() ?? lookupPath;
    rows = rows.filter((memory) => {
      const rank = pathRank(memory.path, lookupPath);
      if (rank !== null) return true;
      const haystack = `${memory.path ?? ''}\n${memory.content ?? ''}`.toLowerCase();
      return haystack.includes(lookupPath.toLowerCase()) || haystack.includes(basename.toLowerCase());
    });
  }
  if (q) rows = rows.filter((m) => memoryMatchesQuery(m, q));

  const sorted = rows.sort((a, b) => {
    const rankA = lookupPath ? pathRank(a.path, lookupPath) : null;
    const rankB = lookupPath ? pathRank(b.path, lookupPath) : null;
    const keyA: [number, number] = rankA ?? [9, 0];
    const keyB: [number, number] = rankB ?? [9, 0];
    if (keyA[0] !== keyB[0]) return keyA[0] - keyB[0];
    if (keyA[1] !== keyB[1]) return keyA[1] - keyB[1];
    if ((b.updated_at ?? 0) !== (a.updated_at ?? 0)) return (b.updated_at ?? 0) - (a.updated_at ?? 0);
    return (a.id ?? '').localeCompare(b.id ?? '');
  });
  return sorted.slice(0, Math.max(1, Math.min(limit || 20, 100)));
}

function listMemoryPathGroups(
  memories: MemoryModel[],
  opts: { query?: string; memoryType?: string; limit?: number }
): Record<string, any> {
  const { query = '', memoryType = 'all', limit = 100 } = opts;
  const rows = (memories ?? []).filter(
    (m) => (memoryType === 'all' || m.type === memoryType) && memoryMatchesQuery(m, query)
  );
  const grouped = new Map<string, Record<string, any>>();
  for (const memory of rows) {
    const key = `${memory.path ?? ''}\u0000${memory.type}`;
    const group = grouped.get(key) ?? {
      path: memory.path,
      type: memory.type,
      count: 0,
      updated_at: 0,
      children: [] as string[],
    };
    group.count += 1;
    group.updated_at = Math.max(group.updated_at, memory.updated_at ?? 0);
    grouped.set(key, group);
  }
  const groups = [...grouped.values()];
  const paths = groups.map((g) => g.path).filter((p): p is string => !!p);
  for (const group of groups) {
    const path = group.path;
    if (!path) continue;
    const prefix = `${path}/`;
    const children: string[] = [];
    for (const candidate of paths) {
      if (!candidate.startsWith(prefix)) continue;
      const remainder = candidate.slice(prefix.length);
      const child = `${prefix}${remainder.split('/', 1)[0]}`;
      if (!children.includes(child)) children.push(child);
    }
    group.children = children.slice(0, 20);
  }
  const sorted = groups.sort((a, b) => b.updated_at - a.updated_at);
  return { paths: sorted.slice(0, Math.max(1, Math.min(limit || 100, 500))), count: groups.length };
}

function readMemoryPathRows(
  memories: MemoryModel[],
  opts: { path: string; memoryType?: string; includeChildren?: boolean; limit?: number }
): Record<string, any> {
  const { path, memoryType = 'all', includeChildren = true, limit = 50 } = opts;
  const lookupPath = cleanMemoryPath(path);
  if (!lookupPath) err(400, 'Memory path is required');

  const rows = (memories ?? []).filter((m) => memoryType === 'all' || m.type === memoryType);
  const pathSet = new Set(rows.map((m) => m.path).filter((p): p is string => !!p));
  const lookupParts = pathParts(lookupPath);
  const parents: string[] = [];
  for (let idx = 1; idx < lookupParts.length; idx++) {
    const candidate = lookupParts.slice(0, idx).join('/');
    if (pathSet.has(candidate)) parents.push(candidate);
  }
  const children = [
    ...new Set(
      rows
        .filter((m) => m.path && m.path.startsWith(`${lookupPath}/`))
        .map((m) => `${lookupPath}/${(m.path as string).slice(lookupPath.length + 1).split('/', 1)[0]}`)
    ),
  ].sort();

  const selectedRows = rows.filter((m) => {
    if (m.path === lookupPath) return true;
    if (m.path && parents.includes(m.path)) return true;
    return Boolean(includeChildren && m.path && m.path.startsWith(`${lookupPath}/`));
  });

  const sorted = selectedRows.sort((a, b) => {
    const key = (m: MemoryModel): [number, number, number, string] => {
      if (m.path === lookupPath) return [0, 0, -(m.updated_at ?? 0), m.id ?? ''];
      if (m.path && m.path.startsWith(`${lookupPath}/`)) {
        return [1, pathParts(m.path).length, -(m.updated_at ?? 0), m.id ?? ''];
      }
      return [2, -pathParts(m.path).length, -(m.updated_at ?? 0), m.id ?? ''];
    };
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < 4; i++) {
      if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    }
    return 0;
  });

  return {
    path: lookupPath,
    parents,
    children: children.slice(0, 50),
    memories: sorted.slice(0, Math.max(1, Math.min(limit || 50, 100))),
  };
}

function validateMemoryOperations(form: { operations?: any[] }): any[] {
  if (!form.operations?.length) err(400, 'No memory operations provided');
  const operations: any[] = [];
  for (const operation of form.operations) {
    const op = { ...(operation ?? {}) };
    const action = op.action;
    if (action === 'add') {
      op.content = cleanMemoryContent(op.content);
      op.type = normalizeMemoryType(op.type);
      op.path = cleanMemoryPath(op.path);
    } else if (action === 'replace') {
      if (!op.id) err(400, 'Memory id is required for replace');
      op.content = cleanMemoryContent(op.content);
      if (op.type !== null && op.type !== undefined) op.type = normalizeMemoryType(op.type);
      op.path = cleanMemoryPath(op.path);
    } else if (action === 'move') {
      if (!op.id) err(400, 'Memory id is required for move');
      op.path = cleanMemoryPath(op.path);
    } else if (action === 'remove') {
      if (!op.id) err(400, 'Memory id is required for remove');
    } else {
      err(400, `Unsupported memory operation: ${action}`);
    }
    operations.push(op);
  }
  return operations;
}

function normalizeMemoryType(memoryType: string | null | undefined): 'user' | 'context' {
  return memoryType === 'user' ? 'user' : 'context';
}

// ---------------------------------------------------------------------------
// Vector helpers (chunk table = serverless vector store)
// ---------------------------------------------------------------------------

const collectionFor = (userId: string) => `user-memory-${userId}`;

async function embedText(text: string): Promise<number[]> {
  return generateEmbedding(env.RAG_EMBEDDING_MODEL, text);
}

async function deleteMemoryVectors(userId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.chunk.deleteMany({ where: { collection_name: collectionFor(userId), id: { in: ids } } });
}

async function deleteMemoryCollection(userId: string): Promise<void> {
  try {
    await db.chunk.deleteMany({ where: { collection_name: collectionFor(userId) } });
  } catch (e) {
    console.debug(e);
  }
}

async function upsertMemoryVectors(
  userId: string,
  items: Array<{ id: string; text: string; vector: number[]; metadata: Record<string, any> }>
): Promise<void> {
  if (!items.length) return;
  await deleteMemoryVectors(userId, items.map((i) => i.id));
  await db.chunk.createMany({
    data: items.map((item) => ({
      id: item.id,
      collection_name: collectionFor(userId),
      knowledge_id: null,
      file_id: null,
      content: item.text,
      embedding: JSON.stringify(item.vector),
      metadata: JSON.stringify(item.metadata ?? {}),
    })),
  });
}

function memoryMetadata(memory: MemoryModel): Record<string, any> {
  return {
    created_at: memory.created_at,
    updated_at: memory.updated_at,
    type: memory.type,
    path: memory.path,
  };
}

async function reindexMemoryVectorsForUser(userId: string, memories?: MemoryModel[] | null): Promise<number> {
  await deleteMemoryCollection(userId);
  const rows = memories ?? (await getMemoriesByUserId(userId));
  if (!rows || !rows.length) return 0;
  const items: Array<{ id: string; text: string; vector: number[]; metadata: Record<string, any> }> = [];
  const vectors = await Promise.all(rows.map((m) => embedText(memoryVectorText(m.content, m.path))));
  rows.forEach((memory, idx) => {
    items.push({
      id: memory.id,
      text: memoryVectorText(memory.content, memory.path),
      vector: vectors[idx],
      metadata: memoryMetadata(memory),
    });
  });
  await upsertMemoryVectors(userId, items);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Memories table ops (models/memories.py)
// ---------------------------------------------------------------------------

async function getMemoriesByUserId(userId: string): Promise<MemoryModel[]> {
  const rows = await db.memory.findMany({ where: { user_id: userId } });
  return rows.map(rowToModel);
}

async function getAllMemories(): Promise<MemoryModel[]> {
  const rows = await db.memory.findMany();
  return rows.map(rowToModel);
}

async function insertNewMemory(
  userId: string,
  content: string,
  memoryType: string | null,
  path: string | null,
  meta: Record<string, any> | null
): Promise<MemoryModel | null> {
  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();
  const row = await db.memory.create({
    data: {
      id,
      user_id: userId,
      type: normalizeMemoryType(memoryType),
      path,
      content,
      meta: meta ? JSON.stringify(meta) : null,
      created_at: now,
      updated_at: now,
    },
  });
  return rowToModel(row);
}

async function updateMemoryByIdAndUserId(
  id: string,
  userId: string,
  content: string | null,
  memoryType: string | null,
  path: string | null,
  updatePath: boolean,
  meta: Record<string, any> | null
): Promise<MemoryModel | null> {
  const existing = await db.memory.findUnique({ where: { id } });
  if (!existing || existing.user_id !== userId) return null;
  const currentMeta = existing.meta ? safeJson(existing.meta) : {};
  const row = await db.memory.update({
    where: { id },
    data: {
      ...(content !== null ? { content } : {}),
      ...(memoryType !== null && memoryType !== undefined ? { type: normalizeMemoryType(memoryType) } : {}),
      ...(updatePath ? { path } : {}),
      ...(meta !== null ? { meta: JSON.stringify({ ...(currentMeta ?? {}), ...meta }) } : {}),
      updated_at: Math.floor(Date.now() / 1000),
    },
  });
  return rowToModel(row);
}

function safeJson(s: string): Record<string, any> | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function deleteMemoryByIdAndUserId(id: string, userId: string): Promise<boolean> {
  const existing = await db.memory.findUnique({ where: { id } });
  if (!existing || existing.user_id !== userId) return false;
  await db.memory.delete({ where: { id } });
  return true;
}

async function deleteMemoriesByUserId(userId: string): Promise<boolean> {
  await db.memory.deleteMany({ where: { user_id: userId } });
  return true;
}

async function applyMemoryOperations(userId: string, operations: any[]): Promise<any[]> {
  const now = Math.floor(Date.now() / 1000);
  const results: any[] = [];
  for (const operation of operations) {
    const action = operation.action;
    if (action === 'add') {
      const content = String(operation.content ?? '').trim();
      const memoryType = normalizeMemoryType(operation.type);
      const path = operation.path ?? null;
      const existing = await db.memory.findFirst({
        where: { user_id: userId, content, type: memoryType, path },
      });
      if (existing) {
        results.push({ action, status: 'skipped', memory: rowToModel(existing), reason: 'duplicate' });
        continue;
      }
      const id = crypto.randomUUID();
      const row = await db.memory.create({
        data: {
          id,
          user_id: userId,
          type: memoryType,
          path,
          content,
          meta: operation.meta ? JSON.stringify(operation.meta) : null,
          created_at: now,
          updated_at: now,
        },
      });
      results.push({ action, status: 'created', memory: rowToModel(row) });
    } else if (action === 'replace' || action === 'move') {
      const memoryId = operation.id;
      const existing = await db.memory.findUnique({ where: { id: memoryId } });
      if (!existing || existing.user_id !== userId) {
        err(404, `Memory not found: ${memoryId}`);
      }
      const currentMeta = existing.meta ? safeJson(existing.meta) ?? {} : {};
      const row = await db.memory.update({
        where: { id: memoryId },
        data: {
          ...(action === 'replace'
            ? {
                content: String(operation.content ?? '').trim(),
                ...(operation.type !== null && operation.type !== undefined
                  ? { type: normalizeMemoryType(operation.type) }
                  : {}),
                ...('path' in operation ? { path: operation.path ?? null } : {}),
              }
            : { path: operation.path ?? null }),
          ...(operation.meta ? { meta: JSON.stringify({ ...currentMeta, ...operation.meta }) } : {}),
          updated_at: now,
        },
      });
      results.push({ action, status: 'updated', memory: rowToModel(row) });
    } else if (action === 'remove') {
      const memoryId = operation.id;
      const existing = await db.memory.findUnique({ where: { id: memoryId } });
      if (!existing || existing.user_id !== userId) {
        err(404, `Memory not found: ${memoryId}`);
      }
      await db.memory.delete({ where: { id: memoryId } });
      results.push({ action, status: 'deleted', id: memoryId });
    } else {
      err(404, `Unsupported memory operation: ${action}`);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Permission gate (Python check_memories_permission)
// ---------------------------------------------------------------------------

async function checkMemoriesPermission(user: { id: string; role: string }): Promise<void> {
  const enabled = await configGet<boolean>('memories.enable', env.ENABLE_MEMORIES);
  if (!enabled) err(404, ERROR_MESSAGES.NOT_FOUND);
  const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
  if (user.role !== 'admin' && !(await hasPermission(user.id, 'features.memories', defaults))) {
    err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // GET /
  {
    method: 'GET',
    path: '',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkMemoriesPermission(user);
      return ctx.json(await getMemoriesByUserId(user.id));
    },
  },

  // POST /add
  {
    method: 'POST',
    path: 'add',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkMemoriesPermission(user);
      const form = await ctx.body<{ content?: string; type?: string; path?: string | null }>();
      const content = cleanMemoryContent(form.content);
      const path = cleanMemoryPath(form.path);
      const memory = await insertNewMemory(user.id, content, form.type ?? 'context', path, {
        created_by: 'manual',
      });
      if (!memory) err(400, EM.DEFAULT('Error creating memory'));

      try {
        const vector = await embedText(memoryVectorText(memory.content, memory.path));
        await upsertMemoryVectors(user.id, [
          {
            id: memory.id,
            text: memoryVectorText(memory.content, memory.path),
            vector,
            metadata: memoryMetadata(memory),
          },
        ]);
      } catch (e) {
        console.error('Memory embedding failed; reindexing memory vectors', e);
        await reindexMemoryVectorsForUser(user.id);
      }
      return ctx.json(memory);
    },
  },

  // POST /update — batch operations
  {
    method: 'POST',
    path: 'update',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkMemoriesPermission(user);
      const form = await ctx.body<{ operations?: any[]; source?: string | null }>();
      const operations = validateMemoryOperations(form);
      const source = form.source ?? 'tool';
      for (const operation of operations) {
        if (['add', 'replace', 'move'].includes(operation.action)) {
          operation.meta = {
            created_by: source,
            chat_id: null,
            message_id: null,
            model: null,
          };
        }
      }

      let results: any[];
      try {
        results = await applyMemoryOperations(user.id, operations);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(404, String((e as Error)?.message ?? e));
      }

      const upsertItems: Array<{ id: string; text: string; vector: number[]; metadata: Record<string, any> }> = [];
      const deleteIds: string[] = [];
      const response: any[] = [];

      for (const result of results) {
        let entry = { ...result };
        const memory = result.memory;
        if (memory && typeof memory === 'object' && 'id' in memory) {
          const { meta, ...memoryWithoutMeta } = memory;
          void meta;
          entry = { ...result, memory: memoryWithoutMeta };
          if (result.status === 'created' || result.status === 'updated') {
            try {
              const vector = await embedText(memoryVectorText(memory.content, memory.path));
              upsertItems.push({
                id: memory.id,
                text: memoryVectorText(memory.content, memory.path),
                vector,
                metadata: memoryMetadata(memory),
              });
            } catch (e) {
              console.error('Memory embedding failed', e);
            }
          }
        }
        if (result.status === 'deleted' && result.id) deleteIds.push(result.id);
        response.push(entry);
      }

      if (upsertItems.length) await upsertMemoryVectors(user.id, upsertItems);
      if (deleteIds.length) await deleteMemoryVectors(user.id, deleteIds);

      return ctx.json(response);
    },
  },

  // POST /query — semantic search
  {
    method: 'POST',
    path: 'query',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkMemoriesPermission(user);
      const form = await ctx.body<{ content?: string; k?: number | null }>();
      const k = form.k ?? 1;

      const memories = await getMemoriesByUserId(user.id);
      if (!memories.length) err(404, 'No memories found for user');

      let vector: number[];
      try {
        vector = await embedText(String(form.content ?? ''));
      } catch (e) {
        console.error('Memory query embedding failed', e);
        return ctx.json({ ids: [[]], documents: [[]], metadatas: [[]], distances: [[]] });
      }

      const chunks = await db.chunk.findMany({ where: { collection_name: collectionFor(user.id) } });
      const scored = chunks
        .map((chunk) => {
          let embedding: number[] = [];
          try {
            embedding = JSON.parse(chunk.embedding);
          } catch {
            embedding = [];
          }
          let metadata: Record<string, any> = {};
          try {
            metadata = JSON.parse(chunk.metadata ?? '{}');
          } catch {
            metadata = {};
          }
          return { id: chunk.id, document: chunk.content, metadata, distance: 1 - cosineSimilarity(vector, embedding) };
        })
        .sort((a, b) => a.distance - b.distance)
        .slice(0, k);

      const relevanceThreshold = await configGet<number>('rag.relevance_threshold', 0.0);
      const filtered =
        relevanceThreshold > 0.0 ? scored.filter((s) => 1 - s.distance >= relevanceThreshold) : scored;

      return ctx.json({
        ids: [filtered.map((s) => s.id)],
        documents: [filtered.map((s) => s.document)],
        metadatas: [filtered.map((s) => s.metadata)],
        distances: [filtered.map((s) => 1 - s.distance)],
      });
    },
  },

  // POST /search
  {
    method: 'POST',
    path: 'search',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkMemoriesPermission(user);
      const form = await ctx.body<{
        query?: string | null;
        type?: string;
        path?: string | null;
        memory_id?: string | null;
        limit?: number;
      }>();
      const memories = await getMemoriesByUserId(user.id);
      return ctx.json(
        searchMemoryRows(memories, {
          query: form.query,
          path: form.path,
          memoryId: form.memory_id,
          memoryType: form.type ?? 'all',
          limit: form.limit ?? 20,
        })
      );
    },
  },

  // POST /paths
  {
    method: 'POST',
    path: 'paths',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkMemoriesPermission(user);
      const form = await ctx.body<{ query?: string; type?: string; limit?: number }>();
      const memories = await getMemoriesByUserId(user.id);
      return ctx.json(
        listMemoryPathGroups(memories, {
          query: form.query ?? '',
          memoryType: form.type ?? 'all',
          limit: form.limit ?? 100,
        })
      );
    },
  },

  // POST /path
  {
    method: 'POST',
    path: 'path',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkMemoriesPermission(user);
      const form = await ctx.body<{ path?: string; type?: string; include_children?: boolean; limit?: number }>();
      const memories = await getMemoriesByUserId(user.id);
      const result = readMemoryPathRows(memories, {
        path: String(form.path ?? ''),
        memoryType: form.type ?? 'all',
        includeChildren: form.include_children ?? true,
        limit: form.limit ?? 50,
      });
      return ctx.json({
        ...result,
        memories: (result.memories as MemoryModel[]).map(({ meta, ...m }) => {
          void meta;
          return m;
        }),
      });
    },
  },

  // POST /reindex (admin)
  {
    method: 'POST',
    path: 'reindex',
    auth: 'admin',
    handler: async (ctx) => {
      const memories = await getAllMemories();
      const byUser = new Map<string, MemoryModel[]>();
      for (const memory of memories) {
        if (!memory.user_id) continue;
        const list = byUser.get(memory.user_id) ?? [];
        list.push(memory);
        byUser.set(memory.user_id, list);
      }
      const users = await db.user.findMany({ select: { id: true } });
      let totalMemories = 0;
      for (const user of users) {
        totalMemories += await reindexMemoryVectorsForUser(user.id, byUser.get(user.id) ?? []);
      }
      return ctx.json({ status: true, total_users: users.length, total_memories: totalMemories });
    },
  },

  // POST /reset
  {
    method: 'POST',
    path: 'reset',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkMemoriesPermission(user);
      await reindexMemoryVectorsForUser(user.id);
      return ctx.json(true);
    },
  },

  // DELETE /delete/user
  {
    method: 'DELETE',
    path: 'delete/user',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkMemoriesPermission(user);
      const result = await deleteMemoriesByUserId(user.id);
      if (result) {
        await deleteMemoryCollection(user.id);
        return ctx.json(true);
      }
      return ctx.json(false);
    },
  },

  // POST /:memory_id/update — must come after static single-segment routes
  {
    method: 'POST',
    path: ':memory_id/update',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkMemoriesPermission(user);
      const memoryId = ctx.params.memory_id;
      const form = await ctx.body<{ content?: string | null; type?: string | null; path?: string | null }>();

      const content = form.content !== null && form.content !== undefined ? cleanMemoryContent(form.content) : null;
      const path = cleanMemoryPath(form.path);
      if (content === null && form.type == null && form.path == null) {
        err(400, 'No memory update provided');
      }

      const memory = await updateMemoryByIdAndUserId(
        memoryId,
        user.id,
        content,
        form.type ?? null,
        path,
        form.path !== null && form.path !== undefined,
        { created_by: 'manual' }
      );
      if (memory === null) err(404, ERROR_MESSAGES.NOT_FOUND);

      if (
        (form.content !== null && form.content !== undefined) ||
        (form.path !== null && form.path !== undefined)
      ) {
        try {
          const vector = await embedText(memoryVectorText(memory.content, memory.path));
          await upsertMemoryVectors(user.id, [
            {
              id: memory.id,
              text: memoryVectorText(memory.content, memory.path),
              vector,
              metadata: memoryMetadata(memory),
            },
          ]);
        } catch (e) {
          console.error('Memory embedding failed', e);
        }
      }
      return ctx.json(memory);
    },
  },

  // DELETE /:memory_id
  {
    method: 'DELETE',
    path: ':memory_id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await checkMemoriesPermission(user);
      const memoryId = ctx.params.memory_id;
      const result = await deleteMemoryByIdAndUserId(memoryId, user.id);
      if (result) {
        await deleteMemoryVectors(user.id, [memoryId]);
        return ctx.json(true);
      }
      return ctx.json(false);
    },
  },
];
