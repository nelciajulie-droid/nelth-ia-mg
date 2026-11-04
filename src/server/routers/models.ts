import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { configGet } from '@/lib/config';
import { ERROR_MESSAGES } from '@/lib/constants';
import { getUserGroupIds, hasPermission, hasAccessGrant } from '@/lib/access-control';
import {
  setAccessGrants,
  validateAccessGrants,
  filterAllowedAccessGrants,
  getAccessibleResourceIds,
  getGrantsByResources,
  toUserResponse,
  getUsersByIds,
  safeParse,
  nowSec,
  uuid,
  EM,
} from '@/lib/models/workspace';
import { getFileById, type FileModel } from '@/lib/retrieval/process';
import type { ApiUser } from '@/lib/auth';
import { broadcastEvent } from '@/lib/events';

/**
 * Port of open_webui/routers/models.py (/api/v1/models).
 *
 * Deviations (documented):
 *  - Background image validation checks size + magic bytes (PNG/JPEG/GIF/WEBP)
 *    instead of a full PIL decode (no pixel-count limit); voice avatar
 *    validation checks file existence/access and UUID shape, not VRMA parsing.
 *  - has_access_to_file is approximated by file ownership + access grants
 *    (upstream also walks knowledge/model/channel references).
 *  - publish_event calls are no-ops (no socket runtime); terminal servers are
 *    not registered (GET /model/update/version dependency check skips them).
 *  - Model "controls" validation checks the merged model registry
 *    (getModelsForUser) instead of request.app.state.MODELS.
 */

const BYPASS_ADMIN_ACCESS_CONTROL = (process.env.BYPASS_ADMIN_ACCESS_CONTROL ??
  process.env.ENABLE_ADMIN_WORKSPACE_CONTENT_ACCESS ??
  'True').toLowerCase() === 'true';

const BYPASS_MODEL_ACCESS_CONTROL = (process.env.BYPASS_MODEL_ACCESS_CONTROL ?? 'False').toLowerCase() === 'true';

const ENABLE_PROFILE_IMAGE_URL_FORWARDING = (
  process.env.ENABLE_PROFILE_IMAGE_URL_FORWARDING ?? 'True'
).toLowerCase() === 'true';

const PROFILE_IMAGE_ALLOWED_MIME_TYPES = new Set(
  (process.env.PROFILE_IMAGE_ALLOWED_MIME_TYPES ?? 'image/png,image/jpeg,image/gif,image/webp')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
);

const BACKGROUND_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const PAGE_ITEM_COUNT = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function err(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

function requireUser(ctx: Ctx) {
  const user = ctx.user;
  if (!user) err(401, ERROR_MESSAGES.NOT_AUTHENTICATED);
  return user;
}

function requireAdmin(ctx: Ctx) {
  const user = requireUser(ctx);
  if (user.role !== 'admin') err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
  return user;
}

function isValidModelId(modelId: string): boolean {
  return Boolean(modelId) && modelId.length <= 256 && !/\s/.test(modelId);
}

/** Python: _safe_static_redirect_path. */
function safeStaticRedirectPath(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  let path = url.split('?')[0].split('#')[0].trim();
  for (let i = 0; i < 2; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return null;
    }
    if (decoded === path) break;
    path = decoded;
  }
  try {
    if (decodeURIComponent(path) !== path) return null;
  } catch {
    return null;
  }
  if (path.includes('\x00') || path.includes('\\')) return null;
  if (!path.startsWith('/')) return null;
  const segments: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  const normalized = `/${segments.join('/')}`;
  if (normalized === '.' || normalized === '/') return null;
  if (normalized !== '/static' && !normalized.startsWith('/static/')) return null;
  if (normalized === '/static') return '/static/';
  return normalized;
}

// ---------------------------------------------------------------------------
// Chat variables schema (utils/chat_variables.py — subset)
// ---------------------------------------------------------------------------

const CHAT_VARIABLE_KEY_RE = /^[a-z][a-z0-9_]*$/;
const CHAT_VARIABLE_ANY_RE = /\{\{\s*chat\.variables\.([^\s|}]+)(?:\s*\|\s*([^}]*))?\s*\}\}/g;

function parseJsonValue(value: string): any {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) return value.slice(1, -1);
  if (/^[[{]/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function safeField(key: string, definition: Record<string, any>): Record<string, any> {
  const allowedKeys = ['default', 'label', 'max', 'maxlength', 'min', 'minlength', 'options', 'placeholder', 'required', 'step', 'type'];
  const field: Record<string, any> = { key };
  for (const fieldKey of allowedKeys.sort()) {
    if (fieldKey in definition) field[fieldKey] = definition[fieldKey];
  }
  if (!('type' in field)) field['type'] = 'text';
  if (field['type'] === 'select' && !Array.isArray(field['options'])) field['options'] = [];
  field['required'] = Boolean(field['required'] ?? false);
  return field;
}

function parseVariableDefinition(definition: string): Record<string, any> {
  const parts = definition.split(':');
  if (!parts.length) return { type: 'text' };
  const [firstPart, ...propertyParts] = parts;
  let fieldType = firstPart.startsWith('type=') ? firstPart.slice(5) : firstPart;
  fieldType = fieldType.trim() || 'text';
  const properties: Record<string, any> = {};
  for (const part of propertyParts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      properties[trimmed] = true;
      continue;
    }
    properties[trimmed.slice(0, eq).trim()] = parseJsonValue(trimmed.slice(eq + 1).trim());
  }
  return { type: fieldType, ...properties };
}

/** Python: get_chat_variables_schema (chat.variables subset). */
function getChatVariablesSchema(systemPrompt: string | null): Record<string, any> | null {
  if (!systemPrompt) return null;
  const fieldsByKey = new Map<string, Record<string, any>>();
  const typedFieldsByKey = new Map<string, Record<string, any>>();
  for (const match of systemPrompt.matchAll(CHAT_VARIABLE_ANY_RE)) {
    const key = match[1].trim();
    const definition = match[2];
    if (!CHAT_VARIABLE_KEY_RE.test(key)) continue;
    if (definition === undefined || !definition.trim()) {
      if (!fieldsByKey.has(key)) fieldsByKey.set(key, safeField(key, { type: 'text' }));
      continue;
    }
    const field = safeField(key, parseVariableDefinition(definition.trim()));
    if (field['type'] === 'select' && !field['options']) continue;
    const previous = typedFieldsByKey.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(field)) continue;
    typedFieldsByKey.set(key, field);
    fieldsByKey.set(key, field);
  }
  if (!fieldsByKey.size) return null;
  return { fields: [...fieldsByKey.values()] };
}

/** Python: add_chat_variables_schema. */
function addChatVariablesSchema(modelDict: Record<string, any>): Record<string, any> {
  const params = modelDict['params'];
  const system = params && typeof params === 'object' ? params['system'] : null;
  const schema = getChatVariablesSchema(typeof system === 'string' ? system : null);
  if (schema) {
    if (!modelDict['meta'] || typeof modelDict['meta'] !== 'object') modelDict['meta'] = {};
    modelDict['meta']['chat_variables_schema'] = schema;
  } else if (modelDict['meta'] && typeof modelDict['meta'] === 'object') {
    delete modelDict['meta']['chat_variables_schema'];
  }
  return modelDict;
}

// ---------------------------------------------------------------------------
// Model data layer (models/models.py + models/model_history.py port —
// lives here because the shared workspace module has no model CRUD)
// ---------------------------------------------------------------------------

type ModelRow = {
  id: string;
  user_id: string | null;
  base_model_id: string | null;
  name: string | null;
  params: string | null;
  meta: string | null;
  version_id: string | null;
  is_active: boolean | null;
  updated_at: number | null;
  created_at: number | null;
};

type ModelModel = {
  id: string;
  user_id: string | null;
  base_model_id: string | null;
  name: string | null;
  params: Record<string, any>;
  meta: Record<string, any>;
  version_id: string | null;
  is_active: boolean;
  updated_at: number | null;
  created_at: number | null;
  access_grants: any[];
};

function rowToModel(row: ModelRow, grants: any[] = []): ModelModel {
  return {
    id: row.id,
    user_id: row.user_id ?? null,
    base_model_id: row.base_model_id ?? null,
    name: row.name ?? null,
    params: safeParse<Record<string, any>>(row.params, {}) ?? {},
    meta: safeParse<Record<string, any>>(row.meta, {}) ?? {},
    version_id: row.version_id ?? null,
    is_active: row.is_active ?? true,
    updated_at: row.updated_at ?? null,
    created_at: row.created_at ?? null,
    access_grants: grants,
  };
}

/** Python: model_snapshot — {name, base_model_id, params, meta}. */
function modelSnapshot(data: Record<string, any>): Record<string, any> {
  const meta = { ...(data.meta ?? {}) };
  delete meta['hidden'];
  delete meta['chat_variables_schema'];
  return {
    name: data.name ?? null,
    base_model_id: data.base_model_id ?? null,
    params: data.params && typeof data.params === 'object' ? { ...data.params } : {},
    meta,
  };
}

async function getModelGrantsMap(modelIds: string[]): Promise<Record<string, any[]>> {
  return getGrantsByResources('model', modelIds);
}

async function getModelById(id: string): Promise<ModelModel | null> {
  const row = (await db.model.findUnique({ where: { id } })) as ModelRow | null;
  if (!row) return null;
  const grantsMap = await getModelGrantsMap([id]);
  return rowToModel(row, grantsMap[id] ?? []);
}

async function getModelsByIds(ids: string[]): Promise<ModelModel[]> {
  if (!ids.length) return [];
  const rows = (await db.model.findMany({ where: { id: { in: ids } } })) as ModelRow[];
  const grantsMap = await getModelGrantsMap(rows.map((r) => r.id));
  return rows.map((row) => rowToModel(row, grantsMap[row.id] ?? []));
}

async function getAllModels(): Promise<ModelModel[]> {
  const rows = (await db.model.findMany()) as ModelRow[];
  const grantsMap = await getModelGrantsMap(rows.map((r) => r.id));
  return rows.map((row) => rowToModel(row, grantsMap[row.id] ?? []));
}

async function getBaseModels(tag: string | null): Promise<ModelModel[]> {
  const rows = (await db.model.findMany({ where: { base_model_id: null } })) as ModelRow[];
  let filtered = rows;
  if (tag) {
    filtered = rows.filter((row) => {
      const meta = safeParse<Record<string, any>>(row.meta, {}) ?? {};
      return (meta['tags'] ?? []).some((t: any) => (typeof t === 'object' && t ? t['name'] : String(t)) === tag);
    });
  }
  const grantsMap = await getModelGrantsMap(filtered.map((r) => r.id));
  return filtered.map((row) => rowToModel(row, grantsMap[row.id] ?? []));
}

/** Python: get_models — non-base models (+optional writable filter / ids). */
async function getModelsList(opts: { writableByUserId?: string | null; ids?: string[] | null } = {}): Promise<ModelModel[]> {
  const where: Record<string, any> = { base_model_id: { not: null } };
  if (opts.ids) where['id'] = { in: opts.ids };
  let rows = (await db.model.findMany({ where })) as ModelRow[];
  if (opts.writableByUserId) {
    const userGroupIds = await getUserGroupIds(opts.writableByUserId);
    const writable = await getAccessibleResourceIds(
      opts.writableByUserId,
      'model',
      rows.map((r) => r.id),
      'write',
      userGroupIds
    );
    rows = rows.filter((r) => r.user_id === opts.writableByUserId || writable.has(r.id));
  }
  const grantsMap = await getModelGrantsMap(rows.map((r) => r.id));
  return rows.map((row) => rowToModel(row, grantsMap[row.id] ?? []));
}

async function getModelMetaById(id: string): Promise<{ meta: Record<string, any>; user_id: string; updated_at: number | null } | null> {
  const row = (await db.model.findUnique({ where: { id }, select: { meta: true, user_id: true, updated_at: true } })) as
    | { meta: string | null; user_id: string | null; updated_at: number | null }
    | null;
  if (!row) return null;
  return {
    meta: safeParse<Record<string, any>>(row.meta, {}) ?? {},
    user_id: row.user_id ?? '',
    updated_at: row.updated_at ?? null,
  };
}

async function getAllTags(userId: string, isAdmin: boolean, isBaseModel = false): Promise<string[]> {
  const rows = (await db.model.findMany({
    where: { base_model_id: isBaseModel ? null : { not: null } },
    select: { meta: true, user_id: true, id: true },
  })) as Array<{ meta: string | null; user_id: string | null; id: string }>;
  let visible = rows;
  if (!isAdmin) {
    const userGroupIds = await getUserGroupIds(userId);
    const readable = await getAccessibleResourceIds(userId, 'model', rows.map((r) => r.id), 'read', userGroupIds);
    visible = rows.filter((r) => r.user_id === userId || readable.has(r.id));
  }
  const tags = new Set<string>();
  for (const row of visible) {
    const meta = safeParse<Record<string, any>>(row.meta, {}) ?? {};
    for (const tag of meta['tags'] ?? []) {
      const name = typeof tag === 'object' && tag ? tag['name'] : String(tag);
      if (name) tags.add(String(name));
    }
  }
  return [...tags];
}

async function newModelHistoryEntry(
  modelId: string,
  snapshot: Record<string, any>,
  userId: string,
  parentId: string | null,
  commitMessage: string | null
): Promise<{ id: string; snapshot: Record<string, any> }> {
  const id = uuid();
  await db.modelHistory.create({
    data: {
      id,
      model_id: modelId,
      parent_id: parentId,
      snapshot: JSON.stringify(snapshot),
      user_id: userId,
      commit_message: commitMessage,
      created_at: nowSec(),
    },
  });
  return { id, snapshot };
}

async function getModelHistoryById(
  modelId: string,
  historyId: string
): Promise<(Record<string, any> & { snapshot: Record<string, any> }) | null> {
  const row = await db.modelHistory.findFirst({ where: { model_id: modelId, id: historyId } });
  if (!row) return null;
  const author = await db.user.findUnique({ where: { id: row.user_id }, select: { name: true } });
  return {
    id: row.id,
    model_id: row.model_id,
    parent_id: row.parent_id ?? null,
    user_id: row.user_id,
    commit_message: row.commit_message ?? null,
    created_at: row.created_at,
    user: author ? { name: author.name } : null,
    snapshot: safeParse<Record<string, any>>(row.snapshot, {}) ?? {},
  };
}

async function getModelHistoryByModelId(modelId: string, page = 1): Promise<Array<Record<string, any>>> {
  const limit = 20;
  const rows = await db.modelHistory.findMany({
    where: { model_id: modelId },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    skip: (Math.max(1, page) - 1) * limit,
    take: limit,
  });
  const authors = await getUsersByIds([...new Set(rows.map((r) => r.user_id))]);
  const authorMap = new Map(authors.map((u) => [u.id, u.name]));
  return rows.map((row) => ({
    id: row.id,
    model_id: row.model_id,
    parent_id: row.parent_id ?? null,
    user_id: row.user_id,
    commit_message: row.commit_message ?? null,
    created_at: row.created_at,
    user: authorMap.has(row.user_id) ? { name: authorMap.get(row.user_id)! } : null,
  }));
}

async function deleteModelHistoryEntry(modelId: string, historyId: string): Promise<boolean> {
  const model = (await db.model.findUnique({ where: { id: modelId } })) as ModelRow | null;
  if (!model) return false;
  if (model.version_id === historyId) {
    throw new HttpError(400, 'Cannot delete the current version');
  }
  const entry = await db.modelHistory.findFirst({ where: { id: historyId, model_id: modelId } });
  if (!entry) return false;
  await db.modelHistory.updateMany({
    where: { model_id: modelId, parent_id: historyId },
    data: { parent_id: entry.parent_id ?? null },
  });
  await db.modelHistory.delete({ where: { id: historyId } });
  return true;
}

/** Python: _write_model — insert or optimistic-concurrency update + history. */
async function writeModel(
  form: Record<string, any>,
  userId: string,
  current: ModelModel | null,
  productionVersionId?: string | null
): Promise<ModelModel> {
  const meta = { ...(form['meta'] ?? {}) };
  delete meta['chat_variables_schema'];
  const data: Record<string, any> = {
    name: form['name'],
    base_model_id: form['base_model_id'] ?? null,
    params: form['params'] && typeof form['params'] === 'object' ? form['params'] : {},
    meta,
  };
  const snapshot = modelSnapshot(data);

  if (current === null) {
    const entry = await newModelHistoryEntry(form['id'], snapshot, userId, null, form['commit_message'] ?? null);
    const now = nowSec();
    await db.model.create({
      data: {
        id: form['id'],
        user_id: userId,
        base_model_id: data['base_model_id'],
        name: data['name'],
        params: JSON.stringify(data['params']),
        meta: JSON.stringify(data['meta']),
        version_id: entry.id,
        is_active: form['is_active'] ?? true,
        created_at: now,
        updated_at: now,
      },
    });
    await setAccessGrants('model', form['id'], form['access_grants'] ?? null);
    return (await getModelById(form['id']))!;
  }

  // Python _write_model: access grants are only (re)written on insert —
  // updates never touch them (the dedicated /model/access/update route does).
  const values: Record<string, any> = {
    base_model_id: data['base_model_id'],
    name: data['name'],
    params: JSON.stringify(data['params']),
    meta: JSON.stringify(data['meta']),
  };
  // Omitted operational state must not reset a disabled model.
  if (form['is_active'] !== undefined) values['is_active'] = form['is_active'];

  const previous = modelSnapshot(current);
  if (productionVersionId !== null && productionVersionId !== undefined) {
    const entry = await db.modelHistory.findFirst({ where: { id: productionVersionId, model_id: current.id } });
    if (!entry) throw new HttpError(404, 'Model version not found');
    values['version_id'] = entry.id;
    delete values['is_active'];
    // Visibility belongs to the live model, not the historical snapshot.
    const valuesMeta = data['meta'];
    delete valuesMeta['hidden'];
    if ('hidden' in (current.meta ?? {})) valuesMeta['hidden'] = current.meta['hidden'];
    values['meta'] = JSON.stringify(valuesMeta);
  } else if (JSON.stringify(snapshot) !== JSON.stringify(previous)) {
    const entry = await newModelHistoryEntry(
      current.id,
      snapshot,
      userId,
      current.version_id ?? null,
      form['commit_message'] ?? null
    );
    values['version_id'] = entry.id;
  }
  values['updated_at'] = nowSec();
  const result = await db.model.updateMany({
    where: { id: current.id, version_id: current.version_id ?? null },
    data: values,
  });
  if (result.count !== 1) {
    throw new HttpError(409, { code: 'version_conflict' } as unknown as string);
  }
  return (await getModelById(form['id']))!;
}

async function insertNewModel(form: Record<string, any>, userId: string): Promise<ModelModel | null> {
  try {
    return await writeModel(form, userId, null);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return null;
  }
}

async function updateModelById(
  id: string,
  form: Record<string, any>,
  userId: string | null,
  productionVersionId?: string | null
): Promise<ModelModel | null> {
  const current = await getModelById(id);
  if (!current) return null;
  try {
    return await writeModel(form, userId ?? current.user_id ?? '', current, productionVersionId);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return null;
  }
}

async function toggleModelById(id: string): Promise<ModelModel | null> {
  const row = (await db.model.findUnique({ where: { id } })) as ModelRow | null;
  if (!row) return null;
  await db.model.update({
    where: { id },
    data: { is_active: !(row.is_active ?? true), updated_at: nowSec() },
  });
  return getModelById(id);
}

async function updateModelUpdatedAtById(id: string): Promise<ModelModel | null> {
  const row = (await db.model.findUnique({ where: { id } })) as ModelRow | null;
  if (!row) return null;
  await db.model.update({ where: { id }, data: { updated_at: nowSec() } });
  return getModelById(id);
}

async function deleteModels(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.accessGrant.deleteMany({ where: { resource_type: 'model', resource_id: { in: ids } } });
  await db.modelHistory.deleteMany({ where: { model_id: { in: ids } } });
  await db.model.deleteMany({ where: { id: { in: ids } } });
}

async function deleteModelById(id: string): Promise<boolean> {
  await deleteModels([id]);
  return true;
}

async function deleteAllModels(): Promise<boolean> {
  const rows = (await db.model.findMany({ select: { id: true } })) as Array<{ id: string }>;
  await deleteModels(rows.map((r) => r.id));
  return true;
}

async function syncModels(userId: string, models: Array<Record<string, any>>): Promise<ModelModel[]> {
  const existing = new Map((await getAllModels()).map((m) => [m.id, m]));
  const written: ModelModel[] = [];
  for (const model of models) {
    const form = { ...model };
    written.push(await writeModel(form, userId, existing.get(model['id']) ?? null));
  }
  const keep = new Set(models.map((m) => String(m['id'])));
  const stale = [...existing.keys()].filter((id) => !keep.has(id));
  await deleteModels(stale);
  return written;
}

/** Python: search_models — join users, filter, sort, paginate. */
async function searchModels(
  userId: string,
  filter: Record<string, any>,
  skip: number,
  limit: number
): Promise<{ items: Array<ModelModel & { user: any }>; total: number }> {
  let rows = (await db.model.findMany({ where: { base_model_id: { not: null } } })) as ModelRow[];

  const bypass = filter['bypass'] === true;
  if (!bypass) {
    const userGroupIds = await getUserGroupIds(userId);
    const readable = await getAccessibleResourceIds(userId, 'model', rows.map((r) => r.id), 'read', userGroupIds);
    rows = rows.filter((r) => r.user_id === userId || readable.has(r.id));
  }

  const ownersAll = new Map((await getUsersByIds([...new Set(rows.map((r) => r.user_id).filter((v): v is string => v !== null))])).map((u) => [u.id, u]));

  const queryKey = filter['query'];
  if (queryKey) {
    const q = String(queryKey).toLowerCase();
    rows = rows.filter((r) => {
      const owner = ownersAll.get(r.user_id ?? '');
      return (
        (r.name ?? '').toLowerCase().includes(q) ||
        (r.base_model_id ?? '').toLowerCase().includes(q) ||
        (owner?.name ?? '').toLowerCase().includes(q) ||
        (owner?.email ?? '').toLowerCase().includes(q) ||
        (String((owner as any)?.username ?? '')).toLowerCase().includes(q)
      );
    });
  }
  const viewOption = filter['view_option'];
  if (viewOption === 'created') rows = rows.filter((r) => r.user_id === userId);
  else if (viewOption === 'shared') rows = rows.filter((r) => r.user_id !== userId);

  const tag = filter['tag'];
  if (tag) {
    const lowered = String(tag).toLowerCase();
    rows = rows.filter((r) => {
      const meta = safeParse<Record<string, any>>(r.meta, {}) ?? {};
      return (meta['tags'] ?? []).some((t: any) => {
        const name = typeof t === 'object' && t ? t['name'] : String(t);
        return name !== null && name !== undefined && String(name).toLowerCase() === lowered;
      });
    });
  }

  const orderBy = filter['order_by'];
  const direction = filter['direction'];
  const orderKey = orderBy ?? 'created_at';
  const dir = direction === 'asc' ? 1 : -1;
  rows = [...rows].sort((a, b) => {
    const av = (a as any)[orderKey] ?? 0;
    const bv = (b as any)[orderKey] ?? 0;
    if (av === bv) return 0;
    return (av > bv ? 1 : -1) * dir;
  });

  const total = rows.length;
  const pageRows = rows.slice(skip, skip + limit);
  const grantsMap = await getModelGrantsMap(pageRows.map((r) => r.id));
  const items = pageRows.map((row) => ({
    ...rowToModel(row, grantsMap[row.id] ?? []),
    user: toUserResponse(ownersAll.get(row.user_id ?? '') ?? ({} as any)),
  }));
  return { items, total };
}

// ---------------------------------------------------------------------------
// File access / image validation helpers
// ---------------------------------------------------------------------------

async function hasAccessToFile(fileId: string, user: { id: string; role: string }): Promise<boolean> {
  if (user.role === 'admin') return true;
  const file = await getFileById(fileId);
  if (!file) return false;
  if (file.user_id === user.id) return true;
  return hasAccessGrant(user.id, 'file', fileId, 'read');
}

/** Magic-byte content type detection (validate_background_image subset). */
function detectImageType(data: Buffer): string | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && data.subarray(0, 6).toString('latin1') === 'GIF87a') return 'image/gif';
  if (data.length >= 6 && data.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

async function getFileBytes(file: FileModel): Promise<Buffer | null> {
  const data = file.data ?? {};
  const b64 = data['content_base64'];
  if (typeof b64 === 'string' && b64) return Buffer.from(b64, 'base64');
  return null;
}

function fileIdFromUrl(url: string): string {
  const parts = url.split('/').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0] ?? '';
}

/** Python: _verify_background_image (magic bytes + access; see header note). */
async function verifyBackgroundImage(
  url: string | null | undefined,
  user: { id: string; role: string },
  previousUrl?: string | null
): Promise<void> {
  if (!url || url === previousUrl) return;
  const fileId = fileIdFromUrl(url);
  const file = await getFileById(fileId);
  if (!file || !(user.role === 'admin' || file.user_id === user.id || (await hasAccessToFile(fileId, user)))) {
    throw new HttpError(403, 'Background image is not accessible.');
  }
  const bytes = await getFileBytes(file);
  if (bytes) {
    if (bytes.length > BACKGROUND_IMAGE_MAX_BYTES) {
      throw new HttpError(400, 'Background image must be at most 5 MiB.');
    }
    const contentType = detectImageType(bytes);
    if (!contentType) throw new HttpError(400, 'Background image must be PNG, JPEG, WebP, or GIF.');
    const meta = file.meta ?? {};
    if (meta['content_type'] !== contentType) {
      await db.file.update({
        where: { id: fileId },
        data: { meta: JSON.stringify({ ...meta, content_type: contentType }) },
      });
    }
  }
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Python: _verify_voice_avatar (existence/access; no VRMA parsing — see header). */
async function verifyVoiceAvatar(
  avatar: Record<string, any> | null | undefined,
  user: { id: string; role: string },
  previous?: Record<string, any> | null
): Promise<void> {
  if (!avatar || typeof avatar !== 'object') return;
  const assets = new Map<string, boolean>();
  if (typeof avatar['file_id'] === 'string') assets.set(avatar['file_id'], false);
  for (const asset of [...Object.values(avatar['states'] ?? {}), ...(avatar['gestures'] ?? [])]) {
    if (asset && typeof asset === 'object' && typeof asset['file_id'] === 'string') {
      if (asset['file_id'] === avatar['file_id']) {
        throw new HttpError(400, 'An animation must be a VRMA file, not the avatar.');
      }
      assets.set(asset['file_id'], true);
    }
  }
  const previousIds = new Set<string>();
  if (previous && typeof previous === 'object') {
    if (typeof previous['file_id'] === 'string') previousIds.add(previous['file_id']);
    for (const asset of [...Object.values(previous['states'] ?? {}), ...(previous['gestures'] ?? [])]) {
      if (asset && typeof asset === 'object' && typeof asset['file_id'] === 'string') previousIds.add(asset['file_id']);
    }
  }
  for (const [fileId, isAnimation] of assets.entries()) {
    if (previousIds.has(fileId)) continue;
    void isAnimation;
    if (!UUID_RE.test(fileId)) {
      throw new HttpError(400, 'Avatar or animation file is not accessible. Upload it again.');
    }
    const file = await getFileById(fileId);
    if (!file || !(user.role === 'admin' || file.user_id === user.id || (await hasAccessToFile(fileId, user)))) {
      throw new HttpError(403, 'Avatar or animation file is not accessible. Upload it again.');
    }
  }
}

/** Python: _verify_knowledge_file_access. */
async function verifyKnowledgeFileAccess(
  knowledgeItems: any[] | null | undefined,
  user: { id: string; role: string }
): Promise<void> {
  if (!knowledgeItems || user.role === 'admin') return;
  for (const item of knowledgeItems) {
    if (!item || typeof item !== 'object' || item['type'] !== 'file') continue;
    const fileId = item['id'];
    if (!fileId) continue;
    if (!(await hasAccessToFile(String(fileId), user))) {
      throw new HttpError(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
    }
  }
}

/** Python: _check_model_controls — needs the merged model registry. */
async function checkModelControls(
  form: Record<string, any>,
  previous: ModelModel | null,
  user: { id: string; role: string } | null
): Promise<void> {
  const previousControls = previous?.params?.['model_controls'] ?? {};
  const params = form['params'] && typeof form['params'] === 'object' ? form['params'] : (form['params'] = {});
  if (!('model_controls' in params) || params['model_controls'] === undefined) {
    if (previousControls && Object.keys(previousControls).length) {
      params['model_controls'] = previousControls;
    }
    return;
  }
  const controls = params['model_controls'];
  if (controls && Object.keys(controls).length && user) {
    const { getModelsForUser } = await import('@/lib/models-registry');
    const models = await getModelsForUser(user as unknown as ApiUser);
    const base = models.find((m) => m.id === (form['base_model_id'] ?? form['id']));
    const baseInfo = (base?.info ?? {}) as Record<string, any>;
    if (baseInfo['pipe'] || baseInfo['direct'] || baseInfo['owned_by'] === 'arena' || base?.arena) {
      throw new HttpError(400, 'Model controls require a server-managed provider model.');
    }
  }
}

/** Python: _verify_version_dependencies. */
async function verifyVersionDependencies(user: { id: string; role: string }, form: Record<string, any>): Promise<void> {
  async function requireResource(resourceType: string, resourceId: string, resource: any): Promise<void> {
    if (!resource || resource['is_active'] === false) {
      throw new HttpError(400, `Referenced ${resourceType} is unavailable: ${resourceId}`);
    }
    if (!(user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL) && resource['user_id'] !== user.id) {
      if (!(await hasAccessGrant(user.id, resourceType, resourceId, 'read'))) {
        throw new HttpError(403, `Referenced ${resourceType} is not accessible: ${resourceId}`);
      }
    }
  }

  if (form['base_model_id']) {
    const { getModelsForUser } = await import('@/lib/models-registry');
    const available = await getModelsForUser(user as unknown as ApiUser);
    if (!available.some((m) => m.id === form['base_model_id'])) {
      throw new HttpError(400, 'The base model is unavailable.');
    }
  }
  const meta = form['meta'] ?? {};
  for (const item of meta['knowledge'] ?? []) {
    if (!item || typeof item !== 'object' || !item['id'] || item['legacy']) continue;
    if (item['type'] === 'file') {
      const file = await getFileById(String(item['id']));
      if (!file || !(user.role === 'admin' || (await hasAccessToFile(String(item['id']), user)))) {
        throw new HttpError(400, 'A referenced knowledge file is missing or inaccessible.');
      }
    } else if (item['type'] === 'note') {
      const note = await db.note.findUnique({ where: { id: String(item['id']) } });
      await requireResource('note', String(item['id']), note);
    } else {
      const knowledge = await db.knowledge.findUnique({ where: { id: String(item['id']) } });
      await requireResource('knowledge', String(item['id']), knowledge);
    }
  }
  for (const skillId of meta['skillIds'] ?? []) {
    const skill = await db.skill.findUnique({ where: { id: String(skillId) } });
    await requireResource('skill', String(skillId), skill);
  }
  const toolIds = new Set([...(meta['toolIds'] ?? []), ...(meta['defaultToolIds'] ?? [])]);
  if (toolIds.size) {
    const { getTools } = await import('@/lib/models/workspace');
    const availableTools = new Set((await getTools({ userId: user.id })).map((t) => t.id));
    for (const toolId of toolIds) {
      if (!availableTools.has(String(toolId))) {
        throw new HttpError(400, 'A referenced tool is missing or inaccessible.');
      }
    }
  }
  for (const key of ['filterIds', 'defaultFilterIds', 'actionIds']) {
    for (const functionId of meta[key] ?? []) {
      const fn = await db.function.findUnique({ where: { id: String(functionId) } });
      if (!fn || !fn.is_active) {
        throw new HttpError(400, `A referenced function is unavailable: ${functionId}`);
      }
    }
  }
  // Terminal servers are not registered in this deployment — check skipped.
}

// ---------------------------------------------------------------------------
// Model response shapers
// ---------------------------------------------------------------------------

function modelResponse(model: ModelModel | null): Record<string, any> | null {
  return model ? { ...model } : null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // ------------------- GET /list -------------------
  {
    method: 'GET',
    path: 'list',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const page = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
      const skip = (page - 1) * PAGE_ITEM_COUNT;
      const limit = PAGE_ITEM_COUNT;

      const filter: Record<string, any> = {
        bypass: user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL,
      };
      for (const key of ['query', 'view_option', 'tag', 'order_by', 'direction']) {
        const value = ctx.query.get(key);
        if (value) filter[key] = value;
      }

      const result = await searchModels(user.id, filter, skip, limit);

      const userGroupIds = await getUserGroupIds(user.id);
      const writableModelIds = await getAccessibleResourceIds(
        user.id,
        'model',
        result.items.map((m) => m.id),
        'write',
        userGroupIds
      );

      const items = result.items.map((model) => {
        const data = addChatVariablesSchema({ ...model });
        if (data['meta']) delete data['meta']['profile_image_url'];
        const writeAccess =
          (user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL) ||
          user.id === model.user_id ||
          writableModelIds.has(model.id);
        if (!writeAccess) data['params'] = {};
        return { ...data, write_access: writeAccess };
      });

      return ctx.json({ items, total: result.total });
    },
  },

  // ------------------- GET /all (admin) -------------------
  {
    method: 'GET',
    path: 'all',
    auth: 'admin',
    handler: async (ctx) => {
      requireAdmin(ctx);
      return ctx.json(await getAllModels());
    },
  },

  // ------------------- GET /base/tags -------------------
  // PUBLIC-APP MODE: opened to every member with the workspace.models
  // capability (admin-equivalent access) — the model editor's tag picker
  // relies on it.
  {
    method: 'GET',
    path: 'base/tags',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      if (user.role !== 'admin') {
        const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
        if (!(await hasPermission(user.id, 'workspace.models', defaults))) {
          err(401, ERROR_MESSAGES.UNAUTHORIZED);
        }
      }
      const tags = await getAllTags(user.id, true, true);
      return ctx.json([...tags].sort());
    },
  },

  // ------------------- GET /base -------------------
  // PUBLIC-APP MODE: opened to every member with the workspace.models
  // capability — the model editor's "Base Model" selector relies on it.
  {
    method: 'GET',
    path: 'base',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      if (user.role !== 'admin') {
        const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
        if (!(await hasPermission(user.id, 'workspace.models', defaults))) {
          err(401, ERROR_MESSAGES.UNAUTHORIZED);
        }
      }
      const tag = ctx.query.get('tag');
      return ctx.json(await getBaseModels(tag));
    },
  },

  // ------------------- GET /tags -------------------
  {
    method: 'GET',
    path: 'tags',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const tags = await getAllTags(user.id, user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL);
      return ctx.json([...tags].sort());
    },
  },

  // ------------------- POST /create -------------------
  {
    method: 'POST',
    path: 'create',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const form = await ctx.body<Record<string, any>>();

      if (user.role !== 'admin') {
        const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
        if (!(await hasPermission(user.id, 'workspace.models', defaults))) {
          err(401, ERROR_MESSAGES.UNAUTHORIZED);
        }
      }

      if (!isValidModelId(String(form['id'] ?? ''))) {
        err(400, 'The model ID you entered is too long (max 256 characters, no spaces).');
      }
      if (form['base_model_id'] === form['id']) {
        form['base_model_id'] = null;
      }

      if (await getModelById(String(form['id']))) {
        err(401, EM.ID_TAKEN);
      }

      if (user.role !== 'admin') {
        const { getModelsForUser } = await import('@/lib/models-registry');
        const models = await getModelsForUser(user);
        for (const baseModel of models) {
          const baseModelId = baseModel.id;
          const info = (baseModel.info ?? {}) as Record<string, any>;
          if (info['preset'] || !baseModelId) continue;
          if (form['id'] === baseModelId || (baseModel.owned_by === 'ollama' && form['id'] === baseModelId.split(':')[0])) {
            err(401, EM.ID_TAKEN);
          }
        }
      }

      await verifyKnowledgeFileAccess((form['meta'] ?? {})['knowledge'], user);
      await verifyBackgroundImage((form['meta'] ?? {})['background_image_url'], user);
      await verifyVoiceAvatar((form['meta'] ?? {})['voice_avatar'], user);

      const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
      form['access_grants'] = await filterAllowedAccessGrants(defaults, user.id, user.role, form['access_grants'] ?? null, 'model');

      await checkModelControls(form, null, user);
      const model = await insertNewModel(form, user.id);
      if (!model) err(401, EM.DEFAULT());
      await broadcastEvent('models:refresh');
      return ctx.json(modelResponse(model));
    },
  },

  // ------------------- GET /export -------------------
  {
    method: 'GET',
    path: 'export',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const ids = ctx.query.getAll('ids');

      if (user.role !== 'admin') {
        const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
        if (!(await hasPermission(user.id, 'workspace.models_export', defaults))) {
          err(401, ERROR_MESSAGES.UNAUTHORIZED);
        }
      }

      let models: ModelModel[];
      if (user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL) {
        models = ids.length ? await getModelsByIds(ids) : await getModelsList();
      } else {
        models = await getModelsList({ writableByUserId: user.id, ids: ids.length ? ids : null });
      }
      if (ids.length) {
        const requested = new Set(ids);
        const exported = new Set(models.map((m) => m.id));
        if (requested.size !== exported.size || [...requested].some((id) => !exported.has(id))) {
          err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
        }
      }

      const exported: Array<Record<string, any>> = [];
      for (const model of models) {
        const data = modelResponse(model)!;
        const url = (model.meta ?? {})['background_image_url'];
        if (url) {
          try {
            const file = await getFileById(fileIdFromUrl(String(url)));
            if (!file) throw new Error('Image file is missing');
            const bytes = await getFileBytes(file);
            if (!bytes) throw new Error('Image file is missing');
            if (bytes.length > BACKGROUND_IMAGE_MAX_BYTES) throw new Error('Background image must be at most 5 MiB.');
            const contentType = detectImageType(bytes);
            if (!contentType) throw new Error('Invalid background image.');
            data['background_image_data'] = `data:${contentType};base64,${bytes.toString('base64')}`;
            data['meta']['background_image_url'] = null;
          } catch {
            err(400, `Could not export background for model ${model.id}.`);
          }
        }
        exported.push(data);
      }
      return ctx.json(exported);
    },
  },

  // ------------------- POST /import -------------------
  {
    method: 'POST',
    path: 'import',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const form = await ctx.body<{ models?: any[] }>();

      if (user.role !== 'admin') {
        const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
        if (!(await hasPermission(user.id, 'workspace.models_import', defaults))) {
          err(401, ERROR_MESSAGES.UNAUTHORIZED);
        }
      }

      const data = form.models;
      if (!Array.isArray(data)) err(400, 'Invalid JSON format');

      const modelIds = data
        .map((m) => (m && typeof m === 'object' ? m['id'] : null))
        .filter((id): id is string => Boolean(id) && isValidModelId(String(id)));
      const existingModels = new Map((await getModelsByIds(modelIds)).map((m) => [m.id, m]));

      const existingModelIds = [...existingModels.keys()];
      let writableModelIds = new Set<string>();
      if (user.role !== 'admin' && existingModelIds.length) {
        const userGroupIds = await getUserGroupIds(user.id);
        writableModelIds = await getAccessibleResourceIds(user.id, 'model', existingModelIds, 'write', userGroupIds);
      } else {
        writableModelIds = new Set(existingModelIds);
      }

      const importedIds: string[] = [];
      for (const modelData of data) {
        const modelId = modelData['id'];
        if (modelId && isValidModelId(String(modelId))) {
          if (modelData['base_model_id'] === modelId) {
            modelData['base_model_id'] = null;
          }
          try {
            await verifyKnowledgeFileAccess((modelData['meta'] ?? {})['knowledge'], user);
          } catch {
            continue; // defense-in-depth: skip models referencing inaccessible files
          }

          const existingModel = existingModels.get(modelId);
          let importedModel: Record<string, any>;
          if (existingModel) {
            if (
              user.role !== 'admin' &&
              existingModel.user_id !== user.id &&
              !writableModelIds.has(modelId)
            ) {
              err(401, EM.ID_TAKEN);
            }
            modelData['meta'] = { ...(existingModel.meta ?? {}), ...(modelData['meta'] ?? {}) };
            modelData['params'] = modelData['params'] ?? {};
            importedModel = { ...structuredClone({ ...existingModel }), ...modelData };
            delete importedModel['user'];
            delete importedModel['access_grants'];
            importedModel['access_grants'] = existingModel.access_grants ?? [];
          } else {
            modelData['meta'] = modelData['meta'] ?? {};
            modelData['params'] = modelData['params'] ?? {};
            importedModel = { ...modelData };

            const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
            importedModel['access_grants'] = await filterAllowedAccessGrants(
              defaults,
              user.id,
              user.role,
              importedModel['access_grants'] ?? null,
              'model'
            );
          }

          await checkModelControls(importedModel, existingModel ?? null, user);

          // A failed response can follow a commit; clean up orphaned uploads.
          let uploadedId: string | null = null;
          let saveAttempted = false;
          try {
            const encoded = modelData['background_image_data'];
            delete modelData['background_image_data'];
            if (typeof encoded === 'string' && encoded) {
              if (encoded.length > 4 * Math.ceil((BACKGROUND_IMAGE_MAX_BYTES + 2) / 3) + 64) {
                err(400, 'Background image must be at most 5 MiB.');
              }
              const commaIndex = encoded.indexOf(',');
              const header = encoded.slice(0, commaIndex);
              const payload = encoded.slice(commaIndex + 1);
              const imageData = Buffer.from(payload, 'base64');
              const contentType = detectImageType(imageData);
              if (!contentType || header !== `data:${contentType};base64`) {
                err(400, 'Invalid background image data URI.');
              }
              const { uploadFileHandler } = await import('./files');
              const uploaded = await uploadFileHandler(
                user,
                {
                  bytes: imageData,
                  filename: `background.${contentType.split('/')[1]}`,
                  contentType,
                },
                {},
                false
              );
              uploadedId = String(uploaded['id'] ?? '');
              importedModel['meta']['background_image_url'] = `/api/v1/files/${uploadedId}/content`;
            }
            await verifyBackgroundImage(
              (importedModel['meta'] ?? {})['background_image_url'],
              user,
              existingModel ? (existingModel.meta ?? {})['background_image_url'] : null
            );
            if (existingModel && importedModel['meta'] && !('voice_avatar' in modelData)) {
              importedModel['meta']['voice_avatar'] = (existingModel.meta ?? {})['voice_avatar'] ?? null;
            }
            await verifyVoiceAvatar(
              (importedModel['meta'] ?? {})['voice_avatar'],
              user,
              existingModel ? (existingModel.meta ?? {})['voice_avatar'] : null
            );

            saveAttempted = true;
            const saved = existingModel
              ? await updateModelById(modelId, importedModel, user.id)
              : await insertNewModel(importedModel, user.id);
            if (!saved) err(500, `Could not import model ${modelId}.`);
          } catch (e) {
            if (uploadedId && !saveAttempted) {
              try {
                await db.file.delete({ where: { id: uploadedId } });
              } catch {
                /* best-effort cleanup */
              }
            }
            throw e;
          }

          importedIds.push(modelId);
        }
      }
      return ctx.json(true);
    },
  },

  // ------------------- POST /sync (admin) -------------------
  {
    method: 'POST',
    path: 'sync',
    auth: 'admin',
    handler: async (ctx) => {
      const user = requireAdmin(ctx);
      const form = await ctx.body<{ models?: any[] }>();
      const models = form.models ?? [];
      const existing = new Map((await getAllModels()).map((m) => [m.id, m]));
      for (const model of models) {
        const previous = existing.get(model['id']) ?? null;
        await checkModelControls(model, previous, user);
        if (previous && model['meta'] && !('voice_avatar' in model['meta'])) {
          model['meta']['voice_avatar'] = (previous.meta ?? {})['voice_avatar'] ?? null;
        }
        await verifyVoiceAvatar((model['meta'] ?? {})['voice_avatar'], user, previous ? (previous.meta ?? {})['voice_avatar'] : null);
        if (previous && model['meta'] && !('background_image_url' in model['meta'])) {
          model['meta']['background_image_url'] = (previous.meta ?? {})['background_image_url'] ?? null;
        }
        await verifyBackgroundImage(
          (model['meta'] ?? {})['background_image_url'],
          user,
          previous ? (previous.meta ?? {})['background_image_url'] : null
        );
      }
      const written = await syncModels(user.id, models);
      return ctx.json(written);
    },
  },

  // ------------------- GET /model (query id) -------------------
  {
    method: 'GET',
    path: 'model',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.query.get('id') ?? '';
      const model = await getModelById(id);
      if (!model) err(404, ERROR_MESSAGES.NOT_FOUND);

      const writeAccess =
        (user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL) ||
        user.id === model.user_id ||
        (await hasAccessGrant(user.id, 'model', model.id, 'write'));

      if (writeAccess || (await hasAccessGrant(user.id, 'model', model.id, 'read'))) {
        const modelDict = addChatVariablesSchema({ ...model });
        if (!writeAccess) modelDict['params'] = {};
        return ctx.json({ ...modelDict, user: null, write_access: writeAccess });
      }
      err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
    },
  },

  // ------------------- GET /model/history -------------------
  {
    method: 'GET',
    path: 'model/history',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.query.get('id') ?? '';
      await authorizedModelHistory(id, user);
      const page = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
      return ctx.json(await getModelHistoryByModelId(id, page));
    },
  },

  // ------------------- GET /model/history/:history_id -------------------
  {
    method: 'GET',
    path: 'model/history/:history_id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.query.get('id') ?? '';
      await authorizedModelHistory(id, user);
      const entry = await getModelHistoryById(id, ctx.params.history_id);
      if (!entry) err(404, 'Model version not found');
      return ctx.json(entry);
    },
  },

  // ------------------- DELETE /model/history/:history_id -------------------
  {
    method: 'DELETE',
    path: 'model/history/:history_id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.query.get('id') ?? '';
      await authorizedModelHistory(id, user);
      if (!(await deleteModelHistoryEntry(id, ctx.params.history_id))) {
        err(404, 'Model version not found');
      }
      return ctx.json(true);
    },
  },

  // ------------------- POST /model/update/version -------------------
  {
    method: 'POST',
    path: 'model/update/version',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.query.get('id') ?? '';
      const form = await ctx.body<{ version_id?: string }>();
      const model = await authorizedModelHistory(id, user);
      const entry = await getModelHistoryById(id, String(form.version_id ?? ''));
      if (!entry) err(404, 'Model version not found');
      const versionForm: Record<string, any> = { id, ...structuredClone(entry.snapshot) };
      // A missing historical controls key means an empty configuration, not "preserve current".
      versionForm['params'] = { ...(versionForm['params'] ?? {}), model_controls: (versionForm['params'] ?? {})['model_controls'] ?? {} };
      await checkModelControls(versionForm, model, user);
      await verifyVersionDependencies(user, versionForm);
      await verifyBackgroundImage((versionForm['meta'] ?? {})['background_image_url'], user);
      await verifyVoiceAvatar((versionForm['meta'] ?? {})['voice_avatar'], user);
      const result = await updateModelById(id, versionForm, user.id, entry.id);
      if (result === null) err(404, ERROR_MESSAGES.NOT_FOUND);
      return ctx.json(modelResponse(result));
    },
  },

  // ------------------- GET /model/profile/image -------------------
  {
    method: 'GET',
    path: 'model/profile/image',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.query.get('id') ?? '';

      let profileImageUrl: string | null = null;
      let updatedAt: number | null = null;

      const bypassAccessControl =
        BYPASS_MODEL_ACCESS_CONTROL || (user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL);

      const modelMeta = await getModelMetaById(id);
      if (modelMeta) {
        if (
          bypassAccessControl ||
          user.id === modelMeta.user_id ||
          (await hasAccessGrant(user.id, 'model', id, 'read'))
        ) {
          profileImageUrl = (modelMeta.meta ?? {})['profile_image_url'] ?? null;
          updatedAt = modelMeta.updated_at;
        }
      }

      // Fallback: arena models stored in config (not in the DB)
      if (!profileImageUrl) {
        const arenaModels = (await configGet<any[]>('evaluation.arena.models', [])) ?? [];
        for (const arenaModel of arenaModels) {
          if ((arenaModel ?? {})['id'] === id) {
            const arenaMeta = (arenaModel ?? {})['meta'] ?? {};
            const accessGrants = arenaMeta['access_grants'] ?? [];
            const allowed =
              bypassAccessControl ||
              (!accessGrants.length && user.role === 'admin') ||
              (await hasAccessGrant(user.id, 'model', id, 'read'));
            if (allowed) profileImageUrl = arenaMeta['profile_image_url'] ?? null;
            break;
          }
        }
      }

      if (profileImageUrl) {
        if (profileImageUrl.startsWith('http')) {
          if (ENABLE_PROFILE_IMAGE_URL_FORWARDING) {
            return new Response(null, { status: 302, headers: { location: profileImageUrl } });
          }
          // forwarding disabled → fall through to the default image
        } else if (profileImageUrl.startsWith('data:image')) {
          try {
            const commaIndex = profileImageUrl.indexOf(',');
            const header = profileImageUrl.slice(0, commaIndex);
            const base64Data = profileImageUrl.slice(commaIndex + 1);
            const imageData = Buffer.from(base64Data, 'base64');
            const mediaType = header.split(';')[0].replace(/^data:/, '').toLowerCase();
            if (!PROFILE_IMAGE_ALLOWED_MIME_TYPES.has(mediaType)) {
              return new Response(null, { status: 302, headers: { location: '/static/favicon-tab.svg' } });
            }
            const headers: Record<string, string> = {
              'content-disposition': 'inline',
              'x-content-type-options': 'nosniff',
            };
            if (updatedAt) headers['etag'] = `"${updatedAt}"`;
            return new Response(new Uint8Array(imageData), { status: 200, headers: { ...headers, 'content-type': mediaType } });
          } catch {
            /* fall through to the default image */
          }
        } else {
          const safeStatic = safeStaticRedirectPath(profileImageUrl);
          if (safeStatic) {
            return new Response(null, { status: 302, headers: { location: safeStatic } });
          }
        }
      }

      // Nelth-AI brand fallback (model selectors, lists, mentions...).
      // The chat-response avatar is hidden by design (custom.css) — the
      // animated "N" shows only in the response loading indicator.
      return new Response(null, { status: 302, headers: { location: '/static/assets/nelth-logo-active.svg' } });
    },
  },

  // ------------------- POST /model/toggle -------------------
  {
    method: 'POST',
    path: 'model/toggle',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.query.get('id') ?? '';
      const model = await getModelById(id);
      if (!model) err(401, ERROR_MESSAGES.NOT_FOUND);
      if (
        user.role === 'admin' ||
        model.user_id === user.id ||
        (await hasAccessGrant(user.id, 'model', model.id, 'write'))
      ) {
        const toggled = await toggleModelById(id);
        if (toggled) {
          await broadcastEvent('models:refresh');
          return ctx.json(modelResponse(toggled));
        }
        err(400, EM.DEFAULT('Error updating function'));
      }
      err(401, ERROR_MESSAGES.UNAUTHORIZED);
    },
  },

  // ------------------- POST /model/update -------------------
  {
    method: 'POST',
    path: 'model/update',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const form = await ctx.body<Record<string, any>>();
      const model = await getModelById(String(form['id'] ?? ''));
      if (!model) err(401, ERROR_MESSAGES.NOT_FOUND);

      if (
        model.user_id !== user.id &&
        !(await hasAccessGrant(user.id, 'model', model.id, 'write')) &&
        user.role !== 'admin'
      ) {
        err(400, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      await verifyKnowledgeFileAccess((form['meta'] ?? {})['knowledge'], user);

      if (form['base_model_id'] === undefined) form['base_model_id'] = model.base_model_id;
      if (form['base_model_id'] === form['id']) form['base_model_id'] = null;

      form['meta'] = form['meta'] ?? {};
      if (form['meta']['profile_image_url'] === undefined) {
        form['meta']['profile_image_url'] = (model.meta ?? {})['profile_image_url'] ?? null;
      }
      if (form['meta']['voice_avatar'] === undefined) {
        form['meta']['voice_avatar'] = (model.meta ?? {})['voice_avatar'] ?? null;
      }
      await verifyVoiceAvatar(form['meta']['voice_avatar'], user, (model.meta ?? {})['voice_avatar']);
      if (form['meta']['background_image_url'] === undefined) {
        form['meta']['background_image_url'] = (model.meta ?? {})['background_image_url'] ?? null;
      }
      await verifyBackgroundImage(
        form['meta']['background_image_url'],
        user,
        (model.meta ?? {})['background_image_url']
      );

      await checkModelControls(form, model, user);
      const updated = await updateModelById(String(form['id']), form, user.id);
      await broadcastEvent('models:refresh');
      return ctx.json(modelResponse(updated));
    },
  },

  // ------------------- POST /model/access/update -------------------
  {
    method: 'POST',
    path: 'model/access/update',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const form = await ctx.body<{ id?: string; name?: string | null; access_grants?: any[] }>();
      const id = String(form.id ?? '');
      if (!id || /\s/.test(id)) err(422, 'Invalid model id');

      let model = await getModelById(id);

      // Non-preset models may not have a DB entry yet — create a minimal one.
      // PUBLIC-APP MODE: any member with workspace.models can create the entry
      // (admin-equivalent) so sharing a connection model works for everyone.
      if (!model) {
        const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
        if (user.role !== 'admin' && !(await hasPermission(user.id, 'workspace.models', defaults))) {
          err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
        }
        model = await insertNewModel(
          { id, name: form.name ?? id, meta: {}, params: {}, is_active: true },
          user.id
        );
        if (!model) err(500, EM.DEFAULT('Error creating model entry'));
      }

      if (
        model.user_id !== user.id &&
        !(await hasAccessGrant(user.id, 'model', model.id, 'write')) &&
        user.role !== 'admin'
      ) {
        err(400, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
      const grants = await validateAccessGrants(defaults, user.id, user.role, form.access_grants ?? [], 'model');

      await setAccessGrants('model', id, grants);
      await updateModelUpdatedAtById(id);

      const updated = await getModelById(id);
      await broadcastEvent('models:refresh');
      return ctx.json(modelResponse(updated));
    },
  },

  // ------------------- POST /model/delete -------------------
  {
    method: 'POST',
    path: 'model/delete',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const form = await ctx.body<{ id?: string }>();
      const id = String(form.id ?? '');
      const model = await getModelById(id);
      if (!model) err(401, ERROR_MESSAGES.NOT_FOUND);

      if (
        user.role !== 'admin' &&
        model.user_id !== user.id &&
        !(await hasAccessGrant(user.id, 'model', model.id, 'write'))
      ) {
        err(401, ERROR_MESSAGES.UNAUTHORIZED);
      }

      await broadcastEvent('models:refresh');
      return ctx.json(await deleteModelById(id));
    },
  },

  // ------------------- DELETE /delete/all (admin) -------------------
  {
    method: 'DELETE',
    path: 'delete/all',
    auth: 'admin',
    handler: async (ctx) => {
      requireAdmin(ctx);
      const result = await deleteAllModels();
      await broadcastEvent('models:refresh');
      return ctx.json(result);
    },
  },
];

/** Python: authorized_model_history — write access required for history. */
async function authorizedModelHistory(id: string, user: Ctx['user']): Promise<ModelModel> {
  const model = await getModelById(id);
  if (!model) err(404, ERROR_MESSAGES.NOT_FOUND);
  if (!user) err(401, ERROR_MESSAGES.UNAUTHORIZED);
  if (
    !(
      user.id === model.user_id ||
      (user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL) ||
      (await hasAccessGrant(user.id, 'model', id, 'write'))
    )
  ) {
    err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
  }
  return model;
}
