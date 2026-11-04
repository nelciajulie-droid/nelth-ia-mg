import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { configGet } from '@/lib/config';
import { DEFAULT_USER_PERMISSIONS } from '@/lib/constants';
import { getPermissions, hasAccessGrant } from '@/lib/access-control';
import { HttpError } from '@/server/http';
import { getFolderById, hasFolderAccess, hasFolderWriteAccess } from './folders';
import { ERROR_MESSAGES } from '@/lib/constants';

/**
 * Port of open_webui/models/chats.py (ChatTable) plus the supporting
 * models it owns: models/tags.py (TagTable), models/shared_chats.py
 * (SharedChatsTable), models/chat_messages.py (ChatMessageTable) and the
 * access_grant helpers those routers need (models/access_grants.py subset).
 *
 * The chat tables store JSON in TEXT columns (JSON.stringify / JSON.parse),
 * matching the shared SQLite database written by the Python app.
 *
 * List/search queries are ported as parameterised raw SQL so the exact
 * Python/SQLAlchemy semantics survive:
 *   • meta.internal IS NOT true filter  (json_extract … IS NOT 1)
 *   • unread-first ordering (CASE + NOT EXISTS on chat_message)
 *   • tag / message-content matching via json_each
 */

export type Json = Record<string, any>;

// Unpaired UTF-16 surrogates ONLY. The naive [\uD800-\uDFFF] strip (a
// direct port of the Python sanitize_text_for_db) deleted every valid
// surrogate pair too — and in JavaScript every code point ≥ U+10000 (📎,
// 😊, …) IS a surrogate pair, so all emoji were wiped on every DB write
// (streamed content showed them, reload lost them). Keep the pairs: only
// lone halves are invalid and break JSON.stringify / Postgres.
const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const CHAT_SEARCH_FILTER_PREFIXES = ['tag:', 'folder:', 'pinned:', 'archived:', 'shared:'];

// env.py parity
export const ENABLE_ADMIN_CHAT_ACCESS =
  (process.env.ENABLE_ADMIN_CHAT_ACCESS ?? 'True').toLowerCase() === 'true';
export const ENABLE_ADMIN_EXPORT = (process.env.ENABLE_ADMIN_EXPORT ?? 'True').toLowerCase() === 'true';

const envBool = (key: string, def: string) => (process.env[key] ?? def).toLowerCase() === 'true';
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Python config.py DEFAULT_USER_PERMISSIONS has several keys defaulting to
 * True that the TS constants subset omits (chat.share / chat.import /
 * features.folders / access_grants.*). We re-apply the Python env defaults so
 * permission checks behave identically when nothing is persisted yet.
 */
export const PYTHON_USER_PERMISSIONS: Json = {
  ...DEFAULT_USER_PERMISSIONS,
  chat: {
    ...DEFAULT_USER_PERMISSIONS.chat,
    share: envBool('USER_PERMISSIONS_CHAT_SHARE', 'True'),
    import: envBool('USER_PERMISSIONS_CHAT_IMPORT', 'True'),
  },
  features: {
    ...DEFAULT_USER_PERMISSIONS.features,
    folders: envBool('USER_PERMISSIONS_FEATURES_FOLDERS', 'True'),
  },
  access_grants: {
    allow_users: envBool('USER_PERMISSIONS_ACCESS_GRANTS_ALLOW_USERS', 'True'),
    allow_groups: envBool('USER_PERMISSIONS_ACCESS_GRANTS_ALLOW_GROUPS', 'True'),
  },
  sharing: {
    ...DEFAULT_USER_PERMISSIONS.sharing,
    public_chats: envBool('USER_PERMISSIONS_CHAT_ALLOW_PUBLIC_SHARING', 'True'),
    open_chats: envBool('USER_PERMISSIONS_CHAT_ALLOW_OPEN_SHARING', 'True'),
  },
};

/** Resolves the persisted `user.permissions` config (Config.get('user.permissions')). */
export async function userPermissionsConfig(): Promise<Json> {
  return configGet<Json>('user.permissions', PYTHON_USER_PERMISSIONS);
}

// ---------------------------------------------------------------------------
// Types (pydantic model parity)
// ---------------------------------------------------------------------------

export type ChatModel = {
  id: string;
  user_id: string;
  title: string;
  chat: Json;
  created_at: number;
  updated_at: number;
  share_id: string | null;
  archived: boolean;
  pinned: boolean | null;
  meta: Json;
  variables: Json;
  folder_id: string | null;
  tasks: any[] | null;
  summary: string | null;
  current_message_id: string | null;
  last_read_at: number | null;
  timer_at: number | null;
};

export type ChatForm = {
  chat: Json;
  variables?: Json | null;
  folder_id?: string | null;
};

export type ChatImportForm = ChatForm & {
  meta?: Json | null;
  pinned?: boolean | null;
  archived?: boolean | null;
  current_message_id?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
};

export type ChatTitleIdResponse = {
  id: string;
  title: string;
  updated_at: number;
  created_at: number;
  last_read_at: number | null;
  snippet: string | null;
  active: boolean;
  archived: boolean;
};

export type TagModel = {
  id: string;
  name: string;
  user_id: string;
  meta: Json | null;
};

export type SharedChatModel = {
  id: string;
  chat_id: string;
  user_id: string;
  title: string;
  chat: Json;
  created_at: number;
  updated_at: number;
};

export type SharedChatResponse = {
  id: string;
  chat_id: string;
  title: string;
  share_id: string | null;
  updated_at: number;
  created_at: number;
};

export type ChatListResult = { items: ChatModel[]; total: number };

const isObj = (v: any): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseJsonObj(s: string | null | undefined): Json {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
}

function parseJsonArray(s: string | null | undefined): any[] | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function parseJsonAny(s: string | null | undefined): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function deepEquals(a: any, b: any): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEquals(v, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in b && deepEquals(a[k], b[k]));
  }
  return false;
}

// ---------------------------------------------------------------------------
// sanitize_*_for_db (utils/misc.py)
// ---------------------------------------------------------------------------

export function sanitizeTextForDb(text: string): string {
  if (typeof text !== 'string') return text as any;
  return text.replace(/\x00/g, '').replace(LONE_SURROGATE_RE, '');
}

export function sanitizeDataForDb(obj: any): any {
  if (typeof obj === 'string') return sanitizeTextForDb(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeDataForDb);
  if (isObj(obj)) {
    const out: Json = {};
    for (const [k, v] of Object.entries(obj)) out[sanitizeTextForDb(k)] = sanitizeDataForDb(v);
    return out;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Pure history helpers (utils/misc.py)
// ---------------------------------------------------------------------------

/** Reconstructs the ordered message chain up to `messageId`. */
export function getMessageList(messagesMap: Json | null | undefined, messageId: string | null | undefined): any[] {
  if (!messagesMap) return [];
  let current = messageId != null ? messagesMap[messageId] : undefined;
  if (!current) return [];
  const messageList: any[] = [];
  const visited = new Set<string>();
  let mid: any = messageId;
  while (current && mid != null && !visited.has(mid)) {
    visited.add(mid);
    messageList.push(current);
    mid = isObj(current) ? current.parentId : undefined;
    current = mid != null ? messagesMap[mid] : undefined;
  }
  return messageList;
}

/** Python: get_output_text — text of `type: 'message'` output items. */
export function getOutputText(output: any): string {
  if (!Array.isArray(output)) return '';
  const texts: string[] = [];
  for (const item of output) {
    if (!isObj(item) || item.type !== 'message') continue;
    const parts = item.content;
    if (!Array.isArray(parts)) continue;
    let text = '';
    for (const part of parts) {
      if (isObj(part) && part.text != null) text += String(part.text);
    }
    if (text && !/^\s*$/.test(text)) texts.push(text);
  }
  return texts.join('\n');
}

// ---------------------------------------------------------------------------
// Chat search helpers (models/chats.py)
// ---------------------------------------------------------------------------

export function chatSearchContentQuery(text: string): string {
  const words = sanitizeTextForDb(text)
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.filter((w) => !CHAT_SEARCH_FILTER_PREFIXES.some((p) => w.startsWith(p))).join(' ').trim();
}

export function chatSearchTerms(text: string): string[] {
  const matches = String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(matches)];
}

function chatMessageList(chat: Json | null | undefined): any[] {
  if (!isObj(chat)) return [];
  const history = isObj(chat.history) ? chat.history : null;
  let messages = history && history.messages != null ? history.messages : null;
  if (!(isObj(messages) || Array.isArray(messages)) || (messages as any).length === 0) {
    messages = chat.messages;
  }
  if (isObj(messages)) return Object.values(messages);
  return Array.isArray(messages) ? messages : [];
}

function chatSearchSnippet(chat: Json, searchText: string, maxLength = 200): string | null {
  searchText = chatSearchContentQuery(searchText);
  if (!searchText) return null;
  const messages = chatMessageList(chat);
  const needles = [...new Set([searchText, ...chatSearchTerms(searchText)])];
  for (const needle of needles) {
    for (const message of messages) {
      if (!isObj(message)) continue;
      const content = message.content;
      if (typeof content !== 'string') continue;
      const index = content.toLowerCase().indexOf(needle);
      if (index === -1) continue;
      let start = Math.max(index - Math.floor(maxLength / 2), 0);
      let end = Math.min(start + maxLength, content.length);
      if (index + needle.length > end) {
        end = Math.min(index + needle.length, content.length);
        start = Math.max(end - maxLength, 0);
      }
      const snippet = content.slice(start, end).split(/\s+/).filter(Boolean).join(' ');
      return `${start ? '...' : ''}${snippet}${end < content.length ? '...' : ''}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ChatMessage table (models/chat_messages.py)
// ---------------------------------------------------------------------------

/** Python: utils/session_records.recorded_timestamp */
function recordedTimestamp(value: any): number | null {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  let v = num;
  if (v > 10_000_000_000) v /= 1000;
  v = Math.trunc(v);
  return v >= 1577836800 && v <= nowSec() + 86400 ? v : null;
}

/** Python: utils/response.usage_counter */
function usageCounter(value: any): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/** Python: utils/response.normalize_usage */
function normalizeUsage(usage: Json): Json {
  if (!usage) return {};
  const result: Json = { ...usage };
  const aliases: Record<string, string[]> = {
    input_tokens: ['input_tokens', 'prompt_tokens', 'prompt_eval_count'],
    output_tokens: ['output_tokens', 'completion_tokens', 'eval_count', 'predicted_n'],
    total_tokens: ['total_tokens'],
  };
  for (const [target, keys] of Object.entries(aliases)) {
    const value = keys.map((k) => usageCounter(usage[k])).find((n) => n !== null) ?? null;
    delete result[target];
    if (value !== null) result[target] = value;
  }
  const prompt = usageCounter(usage.prompt_n);
  if (!('input_tokens' in result) && prompt !== null) {
    result.input_tokens = prompt + (usageCounter(usage.cache_n) ?? 0);
  }
  if (!('total_tokens' in result) && 'input_tokens' in result && 'output_tokens' in result) {
    result.total_tokens = result.input_tokens + result.output_tokens;
  }
  for (const key of ['prompt_tokens', 'completion_tokens']) {
    const value = usageCounter(usage[key]);
    delete result[key];
    if (value !== null) result[key] = value;
  }
  return result;
}

function getMessageUsage(data: Json): Json | null {
  const usage = data.usage || (isObj(data.info) ? data.info.usage : null);
  return usage ? normalizeUsage(usage) : null;
}

/** Python: utils/session_records.pair_results */
function pairResults(output: any[]): any[] {
  const results = new Map<any, any>();
  for (const item of output) {
    if (isObj(item) && item.type === 'function_call_output') results.set(item.call_id, item);
  }
  for (const item of output) {
    if (!isObj(item) || item.type !== 'function_call') continue;
    const result = results.get(item.call_id);
    if (result) {
      for (const key of ['started_at', 'ended_at', 'duration', 'error_type']) {
        if (key in result && !(key in item)) item[key] = result[key];
      }
    } else if (item.status === 'completed') {
      item.status = 'unknown';
    }
  }
  return output;
}

/** Python: utils/session_records.normalize_tool_output */
function normalizeToolOutput(output: any): any {
  if (!Array.isArray(output)) return output;
  const items = output.filter(isObj).map((item) => ({ ...item }));
  const normalized: any[] = [];
  const indices = new Map<string, number>();
  let start = 0;
  for (const item of items) {
    const itemType = item.type;
    if (normalized.length && normalized[normalized.length - 1].type === 'function_call_output' && itemType !== 'function_call_output') {
      pairResults(normalized.slice(start));
      indices.clear();
      start = normalized.length;
    }
    const callId = item.call_id ?? item.id;
    if ((itemType === 'function_call' || itemType === 'function_call_output') && callId) {
      const key = `${itemType}\u0000${callId}`;
      if (indices.has(key)) {
        normalized[indices.get(key)!] = { ...normalized[indices.get(key)!], ...item };
        continue;
      }
      indices.set(key, normalized.length);
    }
    normalized.push(item);
  }
  pairResults(normalized.slice(start));
  return normalized;
}

const jsonOrNull = (v: any) => (v === undefined ? null : JSON.stringify(v) === undefined ? null : JSON.stringify(v));

/** Python: ChatMessages.upsert_message — insert or update by composite id. */
export async function upsertChatMessage(
  messageId: string,
  chatId: string,
  userId: string | null,
  data: Json
): Promise<void> {
  const compositeId = `${chatId}-${messageId}`;
  const now = nowSec();
  const existing = await db.chatMessage.findUnique({ where: { id: compositeId } });
  const usage = getMessageUsage(data);
  if (existing) {
    const patch: Record<string, unknown> = { updated_at: now };
    if ('role' in data) patch.role = data.role;
    if ('parent_id' in data || 'parentId' in data) patch.parent_id = data.parent_id ?? data.parentId ?? null;
    if ('content' in data) patch.content = jsonOrNull(data.content);
    if ('output' in data) patch.output = jsonOrNull(normalizeToolOutput(data.output));
    if ('model_id' in data || 'model' in data) patch.model_id = data.model_id ?? data.model ?? null;
    if ('files' in data) patch.files = jsonOrNull(data.files);
    if ('sources' in data) patch.sources = jsonOrNull(data.sources);
    if ('embeds' in data) patch.embeds = jsonOrNull(data.embeds);
    if ('meta' in data) patch.meta = jsonOrNull(data.meta);
    if ('done' in data) patch.done = data.done;
    if ('status_history' in data || 'statusHistory' in data)
      patch.status_history = jsonOrNull(data.status_history ?? data.statusHistory);
    if ('error' in data) patch.error = jsonOrNull(data.error);
    if ('context_summary' in data || 'contextSummary' in data)
      patch.context_summary = data.context_summary ?? data.contextSummary ?? null;
    if (usage) patch.usage = jsonOrNull(usage);
    await db.chatMessage.update({ where: { id: compositeId }, data: patch as any });
  } else {
    await db.chatMessage.create({
      data: {
        id: compositeId,
        chat_id: chatId,
        user_id: userId ?? null,
        role: data.role ?? 'user',
        parent_id: data.parent_id ?? data.parentId ?? null,
        content: jsonOrNull(data.content),
        output: jsonOrNull(normalizeToolOutput(data.output)),
        model_id: data.model_id ?? data.model ?? null,
        files: jsonOrNull(data.files),
        sources: jsonOrNull(data.sources),
        embeds: jsonOrNull(data.embeds),
        meta: jsonOrNull(data.meta),
        done: data.done ?? true,
        status_history: jsonOrNull(data.status_history ?? data.statusHistory),
        error: jsonOrNull(data.error),
        usage: jsonOrNull(usage),
        context_summary: data.context_summary ?? data.contextSummary ?? null,
        created_at: 'timestamp' in data ? (recordedTimestamp(data.timestamp) ?? 0) : now,
        updated_at: now,
      },
    });
  }
}

export async function hasUnfinishedAssistantByChatId(chatId: string): Promise<boolean> {
  const row = await db.chatMessage.findFirst({
    where: { chat_id: chatId, role: 'assistant', done: false },
    select: { id: true },
  });
  return row != null;
}

export async function deleteMessageIdsByChatId(chatId: string, messageIds: Set<string>): Promise<boolean> {
  if (!messageIds.size) return true;
  await db.chatMessage.deleteMany({
    where: { chat_id: chatId, id: { in: [...messageIds].map((mid) => `${chatId}-${mid}`) } },
  });
  return true;
}

const DB_TO_JSON_KEY_MAP: Record<string, string> = {
  parent_id: 'parentId',
  model_id: 'model',
  status_history: 'statusHistory',
  context_summary: 'contextSummary',
  created_at: 'timestamp',
};
const MESSAGE_EXCLUDED_COLUMNS = new Set(['id', 'chat_id', 'updated_at']);

/**
 * Python: ChatMessages.get_messages_map_by_chat_id — {message_id: message}
 * from normalized rows; null when no rows exist (legacy fallback).
 */
export async function getChatMessagesMapByChatId(chatId: string): Promise<Json | null> {
  const rows = await db.chatMessage.findMany({ where: { chat_id: chatId } });
  if (!rows.length) return null;

  const columns = [
    'user_id',
    'role',
    'parent_id',
    'content',
    'output',
    'model_id',
    'files',
    'sources',
    'embeds',
    'meta',
    'done',
    'status_history',
    'error',
    'usage',
    'context_summary',
    'created_at',
  ] as const;

  const prefix = `${chatId}-`;
  const messagesMap: Json = {};
  for (const row of rows) {
    const msgId = row.id.startsWith(prefix) ? row.id.slice(prefix.length) : row.id;
    const msg: Json = { id: msgId };
    for (const key of columns) {
      if (MESSAGE_EXCLUDED_COLUMNS.has(key)) continue;
      let val: any = (row as any)[key];
      if (val === null || val === undefined) continue;
      if (['content', 'output', 'files', 'sources', 'embeds', 'meta', 'status_history', 'error', 'usage'].includes(key)) {
        val = parseJsonAny(val as string);
        if (val === null) continue;
      }
      msg[DB_TO_JSON_KEY_MAP[key] ?? key] = val;
    }
    if (!('content' in msg)) msg.content = '';
    if ('usage' in msg) msg.info = { usage: msg.usage };
    messagesMap[msgId] = msg;
  }
  // Reconstruct childrenIds from parentId links
  for (const [msgId, msg] of Object.entries(messagesMap)) {
    const parentId = isObj(msg) ? msg.parentId : undefined;
    if (parentId != null && parentId in messagesMap) {
      const parent = messagesMap[parentId];
      const children = parent.childrenIds;
      if (!Array.isArray(children)) parent.childrenIds = [msgId];
      else if (!children.includes(msgId)) children.push(msgId);
    }
  }
  for (const msg of Object.values(messagesMap)) {
    if (!('childrenIds' in msg)) msg.childrenIds = [];
  }
  return messagesMap;
}

// ---------------------------------------------------------------------------
// Tag table (models/tags.py)
// ---------------------------------------------------------------------------

function tagRowToModel(row: { id: string; name: string | null; user_id: string; meta: string | null }): TagModel {
  const meta: Json | null = row.meta ? parseJsonObj(row.meta) : null;
  return { id: row.id, name: row.name ?? '', user_id: row.user_id, meta };
}

const tagId = (name: string) => String(name).replace(/ /g, '_').toLowerCase();

export async function getTagByNameAndUserId(name: string, userId: string): Promise<TagModel | null> {
  try {
    const row = await db.tag.findFirst({ where: { id: tagId(name), user_id: userId } });
    return row ? tagRowToModel(row) : null;
  } catch {
    return null;
  }
}

export async function getTagsByUserId(userId: string): Promise<TagModel[]> {
  const rows = await db.tag.findMany({ where: { user_id: userId } });
  return rows.map(tagRowToModel);
}

export async function getTagsByIdsAndUserId(ids: string[], userId: string): Promise<TagModel[]> {
  if (!ids.length) return [];
  const rows = await db.tag.findMany({ where: { id: { in: ids }, user_id: userId } });
  return rows.map(tagRowToModel);
}

export async function deleteTagByNameAndUserId(name: string, userId: string): Promise<boolean> {
  try {
    await db.tag.deleteMany({ where: { id: tagId(name), user_id: userId } });
    return true;
  } catch (e) {
    console.error('delete_tag:', e);
    return false;
  }
}

export async function deleteTagsByIdsAndUserId(ids: string[], userId: string): Promise<boolean> {
  if (!ids.length) return true;
  try {
    await db.tag.deleteMany({ where: { id: { in: ids }, user_id: userId } });
    return true;
  } catch (e) {
    console.error('delete_tags_by_ids:', e);
    return false;
  }
}

/** Create tag rows for any names that don't already exist for the user. */
export async function ensureTagsExist(names: string[], userId: string): Promise<void> {
  if (!names.length) return;
  const ids = names.map(tagId);
  const existing = await db.tag.findMany({ where: { id: { in: ids }, user_id: userId }, select: { id: true } });
  const existingIds = new Set(existing.map((r) => r.id));
  const newTags = ids
    .map((id, i) => ({ id, name: names[i], user_id: userId }))
    .filter((t) => !existingIds.has(t.id));
  if (newTags.length) {
    await db.tag.createMany({ data: newTags }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// SharedChat table (models/shared_chats.py)
// ---------------------------------------------------------------------------

type SharedChatRow = {
  id: string;
  chat_id: string;
  user_id: string;
  title: string | null;
  chat: string | null;
  created_at: number | null;
  updated_at: number | null;
};

function sharedRowToModel(row: SharedChatRow): SharedChatModel {
  return {
    id: row.id,
    chat_id: row.chat_id,
    user_id: row.user_id,
    title: row.title ?? '',
    chat: parseJsonObj(row.chat),
    created_at: row.created_at ?? 0,
    updated_at: row.updated_at ?? 0,
  };
}

/** Snapshot the chat for link sharing; returns the share token as its id. */
export async function createSharedChat(
  chatId: string,
  userId: string,
  shareMode: string | null = null
): Promise<SharedChatModel | null> {
  const chatRow = await db.chat.findUnique({ where: { id: chatId } });
  if (!chatRow) return null;
  const shareId = crypto.randomUUID();
  const now = nowSec();
  const chatJson = parseJsonObj(chatRow.chat);
  const row = await db.sharedChat.create({
    data: {
      id: shareId,
      chat_id: chatId,
      user_id: userId,
      title: chatRow.title,
      chat: JSON.stringify({ ...chatJson, share_mode: shareMode }),
      created_at: now,
      updated_at: now,
    },
  });
  return sharedRowToModel(row as unknown as SharedChatRow);
}

/** Re-snapshot the shared chat with the current state of the original. */
export async function updateSharedChat(
  shareId: string,
  form?: { share_mode?: string | null } | null
): Promise<SharedChatModel | null> {
  const sharedRow = await db.sharedChat.findUnique({ where: { id: shareId } });
  if (!sharedRow) return null;
  const chatRow = await db.chat.findUnique({ where: { id: sharedRow.chat_id } });
  if (!chatRow) return null;

  const sharedChat = parseJsonObj(sharedRow.chat);
  const updates = form && 'share_mode' in form ? { share_mode: form.share_mode ?? null } : {};
  const row = await db.sharedChat.update({
    where: { id: shareId },
    data: {
      title: chatRow.title,
      chat: JSON.stringify({
        ...parseJsonObj(chatRow.chat),
        share_mode: sharedChat.share_mode ?? null,
        ...updates,
      }),
      updated_at: nowSec(),
    },
  });
  return sharedRowToModel(row as unknown as SharedChatRow);
}

export async function setSharedChatShareMode(shareId: string, shareMode: string | null): Promise<void> {
  const sharedRow = await db.sharedChat.findUnique({ where: { id: shareId } });
  if (!sharedRow) return;
  const sharedChat = parseJsonObj(sharedRow.chat);
  let title = sharedRow.title;
  let chatJson = sharedChat;
  if (shareMode === null && sharedChat.share_mode === 'continue') {
    const chatRow = await db.chat.findUnique({ where: { id: sharedRow.chat_id } });
    if (chatRow) {
      chatJson = parseJsonObj(chatRow.chat);
      title = chatRow.title;
    }
  }
  await db.sharedChat.update({
    where: { id: shareId },
    data: { title, chat: JSON.stringify({ ...chatJson, share_mode: shareMode }) },
  });
}

export async function getSharedChatById(shareId: string): Promise<SharedChatModel | null> {
  const row = await db.sharedChat.findUnique({ where: { id: shareId } });
  return row ? sharedRowToModel(row as unknown as SharedChatRow) : null;
}

export async function getSharedChatByChatId(chatId: string): Promise<SharedChatModel | null> {
  const rows = await db.sharedChat.findMany({
    where: { chat_id: chatId },
    orderBy: { updated_at: 'desc' },
    take: 1,
  });
  return rows.length ? sharedRowToModel(rows[0] as unknown as SharedChatRow) : null;
}

const SHARED_CHAT_ORDERABLE = ['id', 'chat_id', 'user_id', 'title', 'chat', 'created_at', 'updated_at'];

export async function getSharedChatsByUserId(
  userId: string,
  filter: Json | null,
  skip: number,
  limit: number
): Promise<SharedChatResponse[]> {
  let orderBy: Prisma.Sql = Prisma.sql`ORDER BY shared_chat.updated_at DESC`;
  let titleCond: Prisma.Sql = Prisma.empty;
  if (filter && Object.keys(filter).length) {
    const queryKey = filter.query;
    if (queryKey) {
      titleCond = Prisma.sql` AND LOWER(shared_chat.title) LIKE LOWER(${'%' + String(queryKey) + '%'})`;
    }
    const orderCol = filter.order_by as string | undefined;
    const direction = filter.direction as string | undefined;
    if (orderCol && direction) {
      if (!SHARED_CHAT_ORDERABLE.includes(orderCol)) throw new Error('Invalid order_by field');
      const dir = direction.toLowerCase();
      if (dir === 'asc') orderBy = Prisma.sql`ORDER BY shared_chat.${Prisma.raw(orderCol)} ASC`;
      else if (dir === 'desc') orderBy = Prisma.sql`ORDER BY shared_chat.${Prisma.raw(orderCol)} DESC`;
      else throw new Error('Invalid direction for ordering');
    }
  }
  const offsetClause = skip ? Prisma.sql` OFFSET ${skip}` : Prisma.empty;
  const rows = await db.$queryRaw<SharedChatRow[]>(
    Prisma.sql`SELECT shared_chat.id, shared_chat.chat_id, shared_chat.user_id, shared_chat.title, shared_chat.chat, shared_chat.created_at, shared_chat.updated_at FROM shared_chat WHERE shared_chat.user_id = ${userId}${titleCond} ${orderBy} LIMIT ${limit}${offsetClause}`
  );
  // Python returns {id: chat_id, chat_id, title, share_id: share token, …}
  return rows.map((sc) => ({
    id: sc.chat_id,
    chat_id: sc.chat_id,
    title: sc.title ?? '',
    share_id: sc.id,
    updated_at: sc.updated_at ?? 0,
    created_at: sc.created_at ?? 0,
  }));
}

export async function deleteSharedChatById(shareId: string): Promise<boolean> {
  try {
    await db.sharedChat.deleteMany({ where: { id: shareId } });
    return true;
  } catch {
    return false;
  }
}

export async function deleteSharedChatByChatId(chatId: string): Promise<boolean> {
  try {
    await db.sharedChat.deleteMany({ where: { chat_id: chatId } });
    return true;
  } catch {
    return false;
  }
}

export async function deleteAllSharedChatsByUserId(userId: string): Promise<boolean> {
  try {
    await db.sharedChat.deleteMany({ where: { user_id: userId } });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Access grants (models/access_grants.py subset used by chat/folder routers)
// ---------------------------------------------------------------------------

export type AccessGrantModel = {
  id: string;
  resource_type: string;
  resource_id: string;
  principal_type: string;
  principal_id: string;
  permission: string;
  created_at: number;
};

type AccessGrantRow = {
  id: string;
  resource_type: string;
  resource_id: string;
  principal_type: string;
  principal_id: string;
  permission: string;
  created_at: number;
};

export function normalizeAccessGrants(accessGrants: any[] | null | undefined): Json[] {
  if (!accessGrants) return [];
  const deduped = new Map<string, Json>();
  for (const grant of accessGrants) {
    if (!isObj(grant)) continue;
    const principalType = grant.principal_type;
    const principalId = grant.principal_id;
    const permission = grant.permission;
    if (!['user', 'group', 'anyone'].includes(principalType)) continue;
    if (!['read', 'write'].includes(permission)) continue;
    if (typeof principalId !== 'string' || !principalId) continue;
    if (principalType === 'anyone' && (principalId !== '*' || permission !== 'read')) continue;
    const key = `${principalType}\u0000${principalId}\u0000${permission}`;
    deduped.set(key, {
      id: typeof grant.id === 'string' && grant.id ? grant.id : crypto.randomUUID(),
      principal_type: principalType,
      principal_id: principalId,
      permission,
    });
  }
  return [...deduped.values()];
}

function stripAnyoneAccessGrants(grants: Json[]): Json[] {
  return grants.filter((g) => g.principal_type !== 'anyone');
}

export async function getGrantsByResource(resourceType: string, resourceId: string): Promise<AccessGrantModel[]> {
  const rows = await db.accessGrant.findMany({
    where: { resource_type: resourceType, resource_id: resourceId },
  });
  return rows.map(
    (r): AccessGrantModel => ({
      id: r.id,
      resource_type: r.resource_type,
      resource_id: r.resource_id,
      principal_type: r.principal_type,
      principal_id: r.principal_id,
      permission: r.permission,
      created_at: r.created_at,
    })
  );
}

/** Replace all grants for a resource from a direct access_grants list. */
export async function setAccessGrants(
  resourceType: string,
  resourceId: string,
  accessGrants: any[] | null | undefined
): Promise<void> {
  await db.accessGrant.deleteMany({ where: { resource_type: resourceType, resource_id: resourceId } });
  const grants = normalizeAccessGrants(accessGrants);
  const now = nowSec();
  for (const g of grants) {
    await db.accessGrant.create({
      data: {
        id: crypto.randomUUID(),
        resource_type: resourceType,
        resource_id: resourceId,
        principal_type: g.principal_type,
        principal_id: g.principal_id,
        permission: g.permission,
        created_at: now,
      },
    });
  }
}

export async function revokeAllAccess(resourceType: string, resourceId: string): Promise<number> {
  const result = await db.accessGrant.deleteMany({
    where: { resource_type: resourceType, resource_id: resourceId },
  });
  return result.count;
}

/** Check for a no-auth anyone:* grant. */
export async function hasAnyoneAccess(
  resourceType: string,
  resourceId: string,
  permission = 'read'
): Promise<boolean> {
  const row = await db.accessGrant.findFirst({
    where: { resource_type: resourceType, resource_id: resourceId, principal_type: 'anyone', principal_id: '*', permission },
  });
  return row != null;
}

// utils/access_control/__init__.py — _SHARING_PERMISSION_KEYS
const SHARING_PERMISSION_KEYS: Record<string, [string | null, string | null, string | null]> = {
  model: ['sharing.models', 'sharing.public_models', null],
  knowledge: ['sharing.knowledge', 'sharing.public_knowledge', null],
  prompt: ['sharing.prompts', 'sharing.public_prompts', null],
  tool: ['sharing.tools', 'sharing.public_tools', null],
  skill: ['sharing.skills', 'sharing.public_skills', null],
  note: ['sharing.notes', 'sharing.public_notes', null],
  folder: ['sharing.folders', null, null],
  channel: [null, 'sharing.public_channels', null],
  calendar: [null, 'sharing.public_calendars', null],
  shared_chat: [null, 'sharing.public_chats', 'sharing.open_chats'],
};

async function filterAllowedAccessGrants(
  defaultPermissions: Json,
  userId: string,
  userRole: string,
  accessGrants: any[] | null | undefined,
  resourceType: string
): Promise<any[] | null> {
  const entry = SHARING_PERMISSION_KEYS[resourceType];
  if (!entry) throw new Error(`Unsupported sharing resource type: ${resourceType}`);
  const [sharingPermissionKey, publicPermissionKey, anyonePermissionKey] = entry;

  if (!accessGrants) return accessGrants ?? null;
  let grants = normalizeAccessGrants(accessGrants);
  if (anyonePermissionKey === null) grants = stripAnyoneAccessGrants(grants);
  if (publicPermissionKey === null) {
    grants = grants.filter((g) => !(g.principal_type === 'user' && g.principal_id === '*'));
  }
  if (userRole === 'admin' || !grants.length) return grants;

  const permissions = await getPermissions(userId, defaultPermissions);
  const allowed = (key: string | null): boolean => {
    if (key === null) return false;
    const [section, name] = key.split('.');
    return Boolean((permissions as any)[section]?.[name] ?? false);
  };
  if (sharingPermissionKey && !allowed(sharingPermissionKey)) return [];
  const allowedAudiences: Record<string, boolean> = {
    anyone: allowed(anyonePermissionKey),
    public: allowed(publicPermissionKey),
    user: allowed('access_grants.allow_users'),
    group: allowed('access_grants.allow_groups'),
  };
  return grants.filter((g) =>
    allowedAudiences[g.principal_type === 'user' && g.principal_id === '*' ? 'public' : g.principal_type]
  );
}

/** Reject unauthorized sharing changes before replacing any stored grants. */
export async function validateAccessGrants(
  defaultPermissions: Json,
  userId: string,
  userRole: string,
  accessGrants: any[],
  resourceType: string
): Promise<Json[]> {
  const grants = normalizeAccessGrants(accessGrants);
  const allowed = await filterAllowedAccessGrants(defaultPermissions, userId, userRole, grants, resourceType);
  if (allowed === null || allowed.length !== grants.length) {
    throw new HttpError(403, 'You do not have permission to share with the requested audience');
  }
  return allowed;
}

// ---------------------------------------------------------------------------
// Chat row conversion + internal helpers
// ---------------------------------------------------------------------------

type ChatRow = {
  id: string;
  user_id: string | null;
  title: string | null;
  chat: string | null;
  created_at: number | null;
  updated_at: number | null;
  share_id: string | null;
  archived: boolean | number | null;
  pinned: boolean | number | null;
  meta: string | null;
  variables: string | null;
  folder_id: string | null;
  tasks: string | null;
  summary: string | null;
  current_message_id: string | null;
  last_read_at: number | null;
  timer_at: number | null;
};

function toBool(v: boolean | number | null | undefined): boolean | null {
  if (v === null || v === undefined) return null;
  return Boolean(v);
}

export function chatRowToModel(row: ChatRow): ChatModel {
  const model: ChatModel = {
    id: row.id,
    user_id: row.user_id ?? '',
    title: row.title ?? '',
    chat: sanitizeDataForDb(parseJsonObj(row.chat)),
    created_at: row.created_at ?? 0,
    updated_at: row.updated_at ?? 0,
    share_id: row.share_id ?? null,
    archived: toBool(row.archived) ?? false,
    pinned: toBool(row.pinned),
    meta: parseJsonObj(row.meta),
    variables: isObj(parseJsonAny(row.variables)) ? parseJsonObj(row.variables) : {},
    folder_id: row.folder_id ?? null,
    tasks: parseJsonArray(row.tasks),
    summary: row.summary ?? null,
    current_message_id: row.current_message_id ?? null,
    last_read_at: row.last_read_at ?? null,
    timer_at: row.timer_at ?? null,
  };
  repairChatCurrentId(model.chat);
  return model;
}

export function isInternalChat(meta: Json | null): boolean {
  return Boolean(meta && meta.internal === true);
}

/** Python: get_current_message_id */
export function getCurrentMessageId(chat: Json | null | undefined): string | null {
  const c = chat ?? {};
  const history = isObj(c.history) ? c.history : ({} as Json);
  const currentId = history.currentId || c.currentId || c.branchPointMessageId;
  if (currentId) return currentId;
  if (Array.isArray(c.messages)) {
    for (let i = c.messages.length - 1; i >= 0; i--) {
      const m = c.messages[i];
      if (isObj(m) && m.id) return m.id;
    }
  }
  return null;
}

function lastDescendantId(messages: Json, messageId: string): string {
  const seen = new Set<string>();
  while (messageId in messages && !seen.has(messageId)) {
    seen.add(messageId);
    const message = messages[messageId];
    const childIds = isObj(message) && Array.isArray(message.childrenIds) ? message.childrenIds : [];
    let nextId: string | null = null;
    for (let i = childIds.length - 1; i >= 0; i--) {
      const childId = childIds[i];
      const child = messages[childId];
      if (
        typeof childId === 'string' &&
        !seen.has(childId) &&
        isObj(child) &&
        child.id === childId &&
        child.role &&
        child.parentId === messageId
      ) {
        nextId = childId;
        break;
      }
    }
    if (!nextId) break;
    messageId = nextId;
  }
  return messageId;
}

function addChildIdToParent(messages: Json, parentId: string | null | undefined, childId: string): boolean {
  const parent = parentId ? messages[parentId] : null;
  if (!isObj(parent)) return false;
  let childIds = parent.childrenIds;
  if (!Array.isArray(childIds)) {
    childIds = [];
    parent.childrenIds = childIds;
  }
  if (childIds.includes(childId)) return false;
  childIds.push(childId);
  return true;
}

/** Python: _repair_chat_current_id — self-heal the currentId pointer. */
export function repairChatCurrentId(chat: Json): boolean {
  const history = chat.history;
  if (!isObj(history)) return false;
  const messages = history.messages;
  if (!isObj(messages)) return false;

  let changed = false;
  for (const [messageId, message] of Object.entries(messages)) {
    if (!isObj(message)) continue;
    changed = addChildIdToParent(messages, message.parentId, messageId) || changed;
  }

  const currentId = history.currentId;
  const currentMessage = currentId != null ? messages[currentId as any] : undefined;
  const output: any[] = isObj(currentMessage) && Array.isArray(currentMessage.output) ? currentMessage.output : [];
  const outputRole = output.find((item) => isObj(item) && item.role)?.role;
  const currentIsBadLeaf =
    isObj(currentMessage) &&
    outputRole === 'assistant' &&
    currentMessage.parentId == null &&
    !currentMessage.timestamp &&
    Object.keys(messages).length > 1;

  if (isObj(currentMessage) && currentMessage.id && currentMessage.role && !currentIsBadLeaf) {
    const lastId = lastDescendantId(messages, currentId as string);
    if (lastId !== currentId) {
      history.currentId = lastId;
      return true;
    }
    return changed;
  }

  let latestLeafId: string | null = null;
  let latestTimestamp = -1;
  for (const [messageId, message] of Object.entries(messages)) {
    if (!isObj(message) || !message.role) continue;
    const childrenIds = Array.isArray(message.childrenIds) ? message.childrenIds : [];
    const timestamp = message.timestamp || 0;
    if (childrenIds.length === 0 && timestamp > latestTimestamp) {
      latestLeafId = messageId;
      latestTimestamp = timestamp;
    }
  }
  if (!latestLeafId || latestLeafId === currentId) return changed;
  history.currentId = latestLeafId;
  return true;
}

/** Python: merge_history — merge stored and incoming histories. */
export function mergeHistory(existingHistory: Json | null | undefined, incomingHistory: Json | null | undefined): Json {
  const existing =
    isObj(existingHistory) && isObj(existingHistory.messages) ? existingHistory.messages : ({} as Json);
  const incoming =
    isObj(incomingHistory) && isObj(incomingHistory.messages) ? incomingHistory.messages : ({} as Json);
  const merged: Json = {};
  for (const [mid, message] of Object.entries({ ...existing, ...incoming })) {
    if (isObj(message)) merged[mid] = { ...message, childrenIds: [] as string[] };
  }
  for (const [mid, message] of Object.entries(merged)) {
    const parentId = message.parentId;
    if (typeof parentId === 'string' && parentId in merged) merged[parentId].childrenIds.push(mid);
  }
  let currentId: any = isObj(incomingHistory) ? incomingHistory.currentId : undefined;
  const has = (k: any) => k !== null && k !== undefined && String(k) in merged;
  if (!has(currentId)) {
    currentId = isObj(existingHistory) ? existingHistory.currentId : undefined;
    if (!has(currentId)) currentId = null;
  }
  return { ...(existingHistory ?? {}), ...(incomingHistory ?? {}), messages: merged, currentId };
}

export function getUnresolvedParentIds(messagesMap: Json): Set<string> {
  const unresolved = new Set<string>();
  for (const message of Object.values(messagesMap)) {
    if (isObj(message) && message.parentId && !(message.parentId in messagesMap)) {
      unresolved.add(message.parentId);
    }
  }
  return unresolved;
}

/** Python: delete_message_from_history — splice a message (and children) out. */
export function deleteMessageFromHistory(history: Json, messageId: string): Set<string> {
  const messages = isObj(history.messages) ? history.messages : ({} as Json);
  const message = messages[messageId];
  if (!isObj(message)) return new Set();

  const parentId = isObj(message.parentId) ? null : message.parentId;
  const childIds = (Array.isArray(message.childrenIds) ? message.childrenIds : []).filter((id: any) => id in messages);
  const grandchildIds: string[] = [];
  for (const childId of childIds) {
    const child = messages[childId];
    for (const gc of isObj(child) && Array.isArray(child.childrenIds) ? child.childrenIds : []) {
      if (gc in messages) grandchildIds.push(gc);
    }
  }

  if (parentId != null && parentId in messages) {
    const parent = messages[parentId];
    const parentChildren = Array.isArray(parent.childrenIds) ? parent.childrenIds : [];
    parent.childrenIds = parentChildren.filter((id: any) => id !== messageId).concat(grandchildIds);
  }
  for (const gc of grandchildIds) {
    const m = messages[gc];
    if (isObj(m)) m.parentId = parentId;
  }

  const deletedIds = new Set<string>([messageId, ...childIds]);
  for (const deletedId of deletedIds) delete messages[deletedId];

  let currentId = parentId;
  let nextChildren: any[] =
    currentId == null
      ? Object.entries(messages)
          .filter(([, m]) => isObj(m) && m.parentId == null)
          .map(([id]) => id)
      : isObj(messages[currentId]) && Array.isArray(messages[currentId].childrenIds)
        ? messages[currentId].childrenIds
        : [];
  const visited = new Set<string>();
  while (nextChildren.length && !visited.has(nextChildren[nextChildren.length - 1])) {
    currentId = nextChildren[nextChildren.length - 1];
    visited.add(currentId);
    nextChildren =
      isObj(messages[currentId]) && Array.isArray(messages[currentId].childrenIds)
        ? messages[currentId].childrenIds
        : [];
  }
  history.currentId = currentId != null && currentId in messages ? currentId : null;
  return deletedIds;
}

/** Python: upsert_message_to_history — insert/update a message in the tree. */
export function upsertMessageToHistory(history: Json, messageId: string, message: Json): Json {
  if (!isObj(history.messages)) history.messages = {};
  const messages = history.messages;

  if (messageId in messages) {
    const existingMeta = isObj(messages[messageId].meta) ? messages[messageId].meta : ({} as Json);
    const incomingMeta = message.meta;
    let mergedMessage = message;
    if (isObj(incomingMeta)) {
      const metaKeys = new Set(Object.keys(incomingMeta));
      const preserveKeys = ['voice', 'task_id', 'response_started_at', 'response_ended_at'];
      if ([...metaKeys].every((k) => preserveKeys.includes(k))) {
        mergedMessage = { ...message, meta: { ...existingMeta, ...incomingMeta } };
      } else {
        const kept: Json = {};
        for (const key of preserveKeys) if (key in existingMeta) kept[key] = existingMeta[key];
        mergedMessage = { ...message, meta: { ...kept, ...incomingMeta } };
      }
    }
    messages[messageId] = { ...messages[messageId], ...mergedMessage };
  } else {
    const messageParentId = message.parentId ?? null;
    let parentId = messageParentId;
    if (parentId === null) {
      for (const [existingId, existingMessage] of Object.entries(messages)) {
        if (isObj(existingMessage) && Array.isArray(existingMessage.childrenIds) && existingMessage.childrenIds.includes(messageId)) {
          parentId = existingId;
          break;
        }
      }
    }
    const parent = parentId != null ? messages[parentId] : null;
    const output = Array.isArray(message.output) ? message.output : [];
    const outputRole = output.find((item) => isObj(item) && item.role)?.role;
    let role = message.role || outputRole;
    if (!role) {
      const parentRole = isObj(parent) ? parent.role : null;
      if (parentRole === 'user') role = 'assistant';
      else if (parentRole === 'assistant') role = 'user';
      else role = 'assistant';
    }
    messages[messageId] = {
      ...message,
      id: message.id || messageId,
      parentId: messageParentId !== null ? messageParentId : parentId,
      childrenIds: Array.isArray(message.childrenIds) ? message.childrenIds : [],
      role,
      timestamp: message.timestamp || nowSec(),
    };
    history.currentId = messageId;
  }

  addChildIdToParent(messages, isObj(messages[messageId]) ? messages[messageId].parentId : null, messageId);
  return messages[messageId];
}

// ---------------------------------------------------------------------------
// Raw SQL fragments (SQLAlchemy semantics parity)
// ---------------------------------------------------------------------------

const INTERNAL_NOT_TRUE = Prisma.sql`(COALESCE(NULLIF(chat.meta, '')::jsonb ->> 'internal', '') NOT IN ('1', 'true', 'True'))`;
const CHAT_COLUMNS = Prisma.sql`chat.id, chat.user_id, chat.title, chat.chat, chat.created_at, chat.updated_at, chat.share_id, chat.archived, chat.pinned, chat.meta, chat.variables, chat.folder_id, chat.tasks, chat.summary, chat.current_message_id, chat.last_read_at, chat.timer_at`;

/** Python: chat_list_order — unread-first or plain column ordering. */
function chatListOrderSql(sortBy: string, sortDir: string, userId?: string): Prisma.Sql {
  if (sortBy !== 'unread_updated_at') {
    const col = sortBy === 'title' ? 'title' : 'updated_at';
    const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
    return Prisma.sql`ORDER BY chat.${Prisma.raw(col)} ${Prisma.raw(dir)}, chat.id`;
  }
  const userCond = userId != null ? Prisma.sql` AND chat.user_id = ${userId}` : Prisma.empty;
  return Prisma.sql`ORDER BY (CASE WHEN chat.updated_at > COALESCE(chat.last_read_at, 0) AND NOT EXISTS (SELECT 1 FROM chat_message WHERE chat_message.chat_id = chat.id AND chat_message.role = 'assistant' AND chat_message.done IS FALSE)${userCond} THEN 1 ELSE 0 END) DESC, chat.updated_at DESC, chat.id`;
}

function titleIdRows(rows: any[]): ChatTitleIdResponse[] {
  return rows.map((r) => ({
    id: r.id as string,
    title: (r.title ?? '') as string,
    updated_at: (r.updated_at ?? 0) as number,
    created_at: (r.created_at ?? 0) as number,
    last_read_at: (r.last_read_at ?? null) as number | null,
    snippet: null,
    active: false,
    archived: false,
  }));
}

const ORDERABLE_CHAT_COLUMNS = [
  'id',
  'user_id',
  'title',
  'chat',
  'created_at',
  'updated_at',
  'share_id',
  'archived',
  'pinned',
  'meta',
  'variables',
  'folder_id',
  'tasks',
  'summary',
  'current_message_id',
  'last_read_at',
  'timer_at',
];

function filterOrderSql(filter: Json | null | undefined, defaultOrder: boolean): { where: Prisma.Sql; order: Prisma.Sql } {
  const conds: Prisma.Sql[] = [];
  let order: Prisma.Sql = defaultOrder ? Prisma.sql`ORDER BY chat.updated_at DESC, chat.id` : Prisma.empty;
  if (filter && Object.keys(filter).length) {
    const queryKey = filter.query;
    if (queryKey) {
      conds.push(Prisma.sql`LOWER(chat.title) LIKE LOWER(${'%' + String(queryKey) + '%'})`);
    }
    const orderBy = filter.order_by as string | undefined;
    const direction = filter.direction as string | undefined;
    if (orderBy && direction && ORDERABLE_CHAT_COLUMNS.includes(orderBy)) {
      const dir = direction.toLowerCase();
      if (dir === 'asc') order = Prisma.sql`ORDER BY chat.${Prisma.raw(orderBy)} ASC, chat.id`;
      else if (dir === 'desc') order = Prisma.sql`ORDER BY chat.${Prisma.raw(orderBy)} DESC, chat.id`;
      else throw new Error('Invalid direction for ordering');
    }
  }
  return { where: conds.length ? Prisma.sql` AND ${Prisma.join(conds, ' AND ')}` : Prisma.empty, order };
}

// ---------------------------------------------------------------------------
// Chats: permission gate (Python: require_chat_creation_permission)
// ---------------------------------------------------------------------------

export async function requireChatCreationPermission(userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (user && user.role === 'admin') return;
  if (!user) throw new HttpError(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
  const permissions = await getPermissions(userId, await userPermissionsConfig());
  const chatPermissions = (permissions.chat ?? {}) as Json;
  if (chatPermissions.temporary && chatPermissions.temporary_enforced) {
    throw new HttpError(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
  }
}

// ---------------------------------------------------------------------------
// Chats: writes
// ---------------------------------------------------------------------------

function extractInitialMessages(chatJson: Json): [string, Json][] {
  const history = isObj(chatJson.history) ? chatJson.history : ({} as Json);
  let messages = isObj(history.messages) ? history.messages : null;
  if (!messages && Array.isArray(chatJson.messages)) {
    messages = {};
    for (const message of chatJson.messages) {
      if (isObj(message) && message.id) messages[message.id] = message;
    }
  }
  return Object.entries(messages ?? {}).filter(([, m]) => isObj(m) && m.role);
}

export async function insertNewChat(
  id: string,
  userId: string,
  form: ChatForm,
  opts: { internalMeta?: Json | null; timerAt?: number | null } = {}
): Promise<ChatModel | null> {
  await requireChatCreationPermission(userId);
  const now = nowSec();
  const chatJson = sanitizeDataForDb(isObj(form.chat) ? form.chat : {});
  const rawTitle = isObj(form.chat) && 'title' in form.chat ? form.chat.title : 'New Chat';
  try {
    await db.chat.create({
      data: {
        id,
        user_id: userId,
        title: sanitizeTextForDb(typeof rawTitle === 'string' ? rawTitle : String(rawTitle)),
        chat: JSON.stringify(chatJson),
        folder_id: form.folder_id ?? null,
        meta: JSON.stringify(opts.internalMeta ?? {}),
        timer_at: opts.timerAt ?? null,
        variables: JSON.stringify(form.variables || {}),
        current_message_id: getCurrentMessageId(form.chat),
        created_at: now,
        updated_at: now,
        last_read_at: now,
      },
    });
  } catch (e) {
    console.error('insert_new_chat:', e);
    return null;
  }

  // Dual-write initial messages to the chat_message table (best effort)
  for (const [messageId, message] of extractInitialMessages(form.chat ?? {})) {
    const msgUserId =
      message.user_id ?? (isObj(message.user) ? message.user.id : null) ?? userId;
    try {
      await upsertChatMessage(messageId, id, msgUserId, message);
    } catch (e) {
      console.warn(`Failed to write initial message ${messageId}:`, e);
    }
  }
  return getChatById(id);
}

function chatImportFormToModel(userId: string, form: ChatImportForm): { model: ChatModel; row: Record<string, unknown> } {
  const id = crypto.randomUUID();
  const now = nowSec();
  const chatJson = sanitizeDataForDb(isObj(form.chat) ? form.chat : {});
  const rawTitle = isObj(form.chat) && 'title' in form.chat ? form.chat.title : 'New Chat';
  const model: ChatModel = {
    id,
    user_id: userId,
    title: sanitizeTextForDb(typeof rawTitle === 'string' ? rawTitle : String(rawTitle)),
    chat: chatJson,
    meta: isObj(form.meta) ? form.meta : {},
    variables: form.variables || {},
    pinned: form.pinned ?? false,
    archived: form.archived ?? false,
    folder_id: form.folder_id ?? null,
    current_message_id: form.current_message_id ?? getCurrentMessageId(form.chat),
    created_at: form.created_at ?? now,
    updated_at: form.updated_at ?? now,
    last_read_at: now,
    share_id: null,
    tasks: null,
    summary: null,
    timer_at: null,
  };
  // attribute message authors like Python does
  const messages = [...Object.values((chatJson.history ?? {}).messages ?? {}), ...(chatJson.messages ?? [])];
  for (const message of messages) {
    if (!isObj(message)) continue;
    message.user_id = message.user_id ?? (isObj(message.user) ? message.user.id : null) ?? userId;
  }
  return {
    model,
    row: {
      id,
      user_id: userId,
      title: model.title,
      chat: JSON.stringify(chatJson),
      meta: JSON.stringify(model.meta),
      variables: JSON.stringify(model.variables),
      pinned: model.pinned,
      archived: model.archived,
      folder_id: model.folder_id,
      current_message_id: model.current_message_id,
      created_at: model.created_at,
      updated_at: model.updated_at,
      last_read_at: model.last_read_at,
    },
  };
}

export async function importChats(userId: string, forms: ChatImportForm[]): Promise<ChatModel[]> {
  await requireChatCreationPermission(userId);

  // Validate folder_id references — clear any the user cannot write to
  const folderIds = new Set(forms.map((f) => f.folder_id).filter(Boolean) as string[]);
  const existing = new Set<string>();
  for (const fid of folderIds) {
    if (await hasFolderWriteAccess(userId, fid)) existing.add(fid);
  }
  const chatImportForms = forms.map((f) =>
    f.folder_id && !existing.has(f.folder_id) ? { ...f, folder_id: null } : f
  );

  const models: ChatModel[] = [];
  for (const form of chatImportForms) {
    const { model, row } = chatImportFormToModel(userId, form);
    await db.chat.create({ data: row as any }).catch((e) => console.error('import_chats:', e));
    models.push(model);
  }

  // Dual-write messages to the chat_message table (best effort)
  for (const [i, form] of chatImportForms.entries()) {
    for (const [messageId, message] of extractInitialMessages(form.chat ?? {})) {
      const msgUserId = message.user_id ?? (isObj(message.user) ? message.user.id : null) ?? userId;
      try {
        await upsertChatMessage(messageId, models[i].id, msgUserId, {
          ...message,
          timestamp: message.timestamp,
        });
      } catch (e) {
        console.warn(`Failed to write imported message ${messageId}:`, e);
      }
    }
  }
  return models;
}

export async function updateChatById(id: string, chatPatch: Json, touch = true): Promise<ChatModel | null> {
  try {
    // Title-only updates (background title generation): update JUST the
    // title column. The generic path below rewrites the whole `chat` JSON
    // (read-modify-write) — running concurrently with the final assistant
    // persist it can resurrect a stale done:false message: the title task
    // reads the row BEFORE the persist and writes its stale snapshot AFTER,
    // wiping the just-persisted streaming result (repro: short answer whose
    // title resolves right around the stream end).
    const patchKeys = Object.keys(chatPatch ?? {});
    if (patchKeys.length === 1 && patchKeys[0] === 'title') {
      const rawTitle = (chatPatch as any).title;
      const title = typeof rawTitle === 'string' ? rawTitle : String(rawTitle ?? 'New Chat');
      await db.chat.update({
        where: { id },
        data: { title, ...(touch ? { updated_at: nowSec() } : {}) } as any,
      });
      return getChatById(id);
    }

    const row = await db.chat.findUnique({ where: { id } });
    if (!row) return null;

    const stored = parseJsonObj(row.chat);
    let updated: Json = { ...stored, ...chatPatch };
    if ('history' in chatPatch) {
      // Merge so messages saved since the caller's last read survive
      updated.history = mergeHistory(isObj(stored.history) ? stored.history : null, isObj(chatPatch.history) ? chatPatch.history : null);
      const storedMessages = isObj(stored.history) && isObj(stored.history.messages) ? stored.history.messages : {};
      const updatedMessages = isObj(updated.history) && isObj(updated.history.messages) ? updated.history.messages : {};
      for (const [mid, message] of Object.entries(storedMessages)) {
        const m = message as Json;
        if (
          (m.user_id ?? row.user_id) !== row.user_id ||
          (m.role === 'assistant' && (m.done === false || updatedMessages[mid]?.done === false))
        ) {
          updatedMessages[mid] = m;
        }
      }
      updated.history = mergeHistory(updated.history, null);
    }
    updated = sanitizeDataForDb(updated);

    const data: Record<string, unknown> = {
      chat: JSON.stringify(updated),
      // Patch without a title → keep the column title (the JSON title may be
      // stale "New Chat" — the title-only fast path updates just the column).
      title:
        typeof (chatPatch as any).title === 'string'
          ? (chatPatch as any).title
          : row.title ?? (typeof updated.title === 'string' ? updated.title : 'New Chat'),
    };
    if ('history' in chatPatch || 'messages' in chatPatch || 'currentId' in chatPatch || 'branchPointMessageId' in chatPatch) {
      data.current_message_id = getCurrentMessageId(updated);
    }
    if (touch) data.updated_at = nowSec();
    await db.chat.update({ where: { id }, data: data as any });

    // Dual-write changed messages
    const patchMessages =
      isObj(chatPatch.history) && isObj(chatPatch.history.messages) ? chatPatch.history.messages : null;
    const storedMessages = isObj(stored.history) && isObj(stored.history.messages) ? stored.history.messages : {};
    const updatedMessages = isObj(updated.history) && isObj(updated.history.messages) ? updated.history.messages : {};
    if (patchMessages) {
      for (const mid of Object.keys(patchMessages)) {
        const message = updatedMessages[mid];
        if (message && message.role && !deepEquals(message, storedMessages[mid])) {
          await upsertChatMessage(mid, id, message.user_id ?? row.user_id ?? '', message).catch(() => undefined);
        }
      }
    }
    return getChatById(id);
  } catch (e) {
    console.error('update_chat_by_id:', e);
    return null;
  }
}

export async function updateChatParamsById(id: string, params: Json): Promise<ChatModel | null> {
  try {
    const row = await db.chat.findUnique({ where: { id } });
    if (!row) return null;
    const stored = parseJsonObj(row.chat);
    const storedParams = isObj(stored.params) ? stored.params : {};
    const updated: Json = {
      ...stored,
      params: sanitizeDataForDb({ ...storedParams, ...params }),
    };
    await db.chat.update({ where: { id }, data: { chat: JSON.stringify(updated) } as any });
    return getChatById(id);
  } catch (e) {
    console.error('update_chat_params_by_id:', e);
    return null;
  }
}

export async function updateChatVariablesById(
  id: string,
  variables: Json | null,
  touch = true
): Promise<ChatModel | null> {
  try {
    const row = await db.chat.findUnique({ where: { id } });
    if (!row) return null;
    const data: Record<string, unknown> = {
      variables: JSON.stringify(isObj(variables) ? variables : {}),
    };
    if (touch) data.updated_at = nowSec();
    await db.chat.update({ where: { id }, data: data as any });
    return getChatById(id);
  } catch (e) {
    console.error('update_chat_variables_by_id:', e);
    return null;
  }
}

export async function markChatUnreadById(id: string, userId: string): Promise<ChatTitleIdResponse | null> {
  try {
    const row = await db.chat.findFirst({ where: { id, user_id: userId } });
    if (!row) return null;
    const updated = await db.chat.update({ where: { id }, data: { last_read_at: 0 } });
    return {
      id: updated.id,
      title: updated.title ?? '',
      updated_at: updated.updated_at ?? 0,
      created_at: updated.created_at ?? 0,
      last_read_at: updated.last_read_at ?? 0,
      snippet: null,
      active: false,
      archived: false,
    };
  } catch {
    return null;
  }
}

export async function markChatsReadByFolderIds(userId: string, folderIds: string[]): Promise<number> {
  if (!folderIds.length) return 0;
  return db.$executeRaw`UPDATE chat SET last_read_at = updated_at WHERE user_id = ${userId} AND folder_id IN (${Prisma.join(
    folderIds
  )}) AND archived = FALSE AND ${INTERNAL_NOT_TRUE}`;
}

export async function markChatsReadByUserId(userId: string): Promise<number> {
  return db.$executeRaw`UPDATE chat SET last_read_at = updated_at WHERE user_id = ${userId} AND archived = FALSE AND ${INTERNAL_NOT_TRUE}`;
}

export async function updateChatShareIdById(id: string, shareId: string | null): Promise<ChatModel | null> {
  try {
    const row = await db.chat.findUnique({ where: { id } });
    if (!row) return null;
    await db.chat.update({ where: { id }, data: { share_id: shareId } });
    return getChatById(id);
  } catch {
    return null;
  }
}

export async function toggleChatPinnedById(id: string): Promise<ChatModel | null> {
  try {
    const row = await db.chat.findUnique({ where: { id } });
    if (!row) return null;
    const now = nowSec();
    await db.chat.update({
      where: { id },
      data: { pinned: !(row.pinned ?? false), updated_at: now, last_read_at: now },
    });
    return getChatById(id);
  } catch {
    return null;
  }
}

export async function toggleChatArchiveById(id: string): Promise<ChatModel | null> {
  try {
    const row = await db.chat.findUnique({ where: { id } });
    if (!row) return null;
    const now = nowSec();
    await db.chat.update({
      where: { id },
      data: { archived: !(row.archived ?? false), folder_id: null, updated_at: now, last_read_at: now },
    });
    return getChatById(id);
  } catch {
    return null;
  }
}

export async function archiveAllChatsByUserId(userId: string): Promise<boolean> {
  try {
    await db.chat.updateMany({ where: { user_id: userId }, data: { archived: true, folder_id: null } });
    return true;
  } catch {
    return false;
  }
}

export async function unarchiveAllChatsByUserId(userId: string): Promise<boolean> {
  try {
    await db.chat.updateMany({ where: { user_id: userId }, data: { archived: false } });
    return true;
  } catch {
    return false;
  }
}

export async function updateChatFolderIdByIdAndUserId(
  id: string,
  userId: string,
  folderId: string | null
): Promise<ChatModel | null> {
  try {
    const row = await db.chat.findUnique({ where: { id } });
    if (!row) return null;
    const data: Record<string, unknown> = { folder_id: folderId };
    if (row.user_id === userId) {
      data.last_read_at = nowSec();
      data.pinned = false;
    }
    if (folderId !== null) data.archived = false;
    await db.chat.update({ where: { id }, data: data as any });
    return getChatById(id);
  } catch (e) {
    console.error('update_chat_folder_id_by_id_and_user_id:', e);
    return null;
  }
}

export async function upsertMessageToChatByIdAndMessageId(
  id: string,
  messageId: string,
  message: Json,
  touch = true
): Promise<ChatModel | null> {
  let msg: Json = { ...message };
  if (!msg.content) {
    const outputText = getOutputText(msg.output);
    if (outputText) msg.content = outputText;
  }
  msg = sanitizeDataForDb(msg);
  const cleanMessageId = sanitizeTextForDb(messageId);
  try {
    const row = await db.chat.findUnique({ where: { id } });
    if (!row) return null;

    const chat = parseJsonObj(row.chat);
    repairChatCurrentId(chat);
    const history = isObj(chat.history) ? chat.history : ({} as Json);
    const savedMessage = upsertMessageToHistory(history, cleanMessageId, msg);
    await upsertChatMessage(cleanMessageId, id, savedMessage.user_id ?? row.user_id ?? '', savedMessage);

    chat.history = history;
    // Title column is authoritative (the background title generation updates
    // it via the title-only fast path — see updateChatById). Sync the JSON
    // title from the column instead of clobbering the column with the stale
    // JSON "New Chat" placeholder.
    if (typeof row.title === 'string' && row.title) chat.title = row.title;
    const data: Record<string, unknown> = {
      chat: JSON.stringify(sanitizeDataForDb(chat)),
      title: (typeof row.title === 'string' && row.title) || (typeof chat.title === 'string' ? sanitizeTextForDb(chat.title) : 'New Chat'),
      current_message_id: getCurrentMessageId(chat),
    };
    if (touch) data.updated_at = nowSec();
    await db.chat.update({ where: { id }, data: data as any });
    return getChatById(id);
  } catch (e) {
    console.error('upsert_message_to_chat_by_id_and_message_id:', e);
    return null;
  }
}

export async function deleteMessageFromChatByIdAndMessageId(
  id: string,
  messageId: string
): Promise<ChatModel | null> {
  try {
    const row = await db.chat.findUnique({ where: { id } });
    if (!row) return null;

    const chat = parseJsonObj(row.chat);
    repairChatCurrentId(chat);
    const history = isObj(chat.history) ? chat.history : ({} as Json);
    const messages = isObj(history.messages) ? history.messages : {};
    const parentId = isObj(messages[messageId]) ? messages[messageId].parentId : undefined;
    const deletedIds = deleteMessageFromHistory(history, messageId);
    await deleteMessageIdsByChatId(id, deletedIds);
    if (!deletedIds.size) {
      await db.chat.update({
        where: { id },
        data: {
          chat: JSON.stringify(sanitizeDataForDb(chat)),
          title: (typeof row.title === 'string' && row.title) || (typeof chat.title === 'string' ? sanitizeTextForDb(chat.title) : 'New Chat'),
          current_message_id: getCurrentMessageId(chat),
        } as any,
      });
      return getChatById(id);
    }

    for (const [mid, message] of Object.entries(isObj(history.messages) ? history.messages : {})) {
      if (isObj(message) && message.parentId === parentId) {
        await upsertChatMessage(mid, id, message.user_id ?? row.user_id ?? '', message).catch(() => undefined);
      }
    }
    await db.chat.update({
      where: { id },
      data: {
        chat: JSON.stringify(sanitizeDataForDb(chat)),
        title: (typeof row.title === 'string' && row.title) || (typeof chat.title === 'string' ? sanitizeTextForDb(chat.title) : 'New Chat'),
        current_message_id: getCurrentMessageId(chat),
        updated_at: nowSec(),
      } as any,
    });
    return getChatById(id);
  } catch (e) {
    console.error('delete_message_from_chat_by_id_and_message_id:', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Chats: single reads
// ---------------------------------------------------------------------------

export async function getChatById(id: string): Promise<ChatModel | null> {
  try {
    const row = await db.chat.findUnique({ where: { id } });
    if (!row) return null;
    return chatRowToModel(row as unknown as ChatRow);
  } catch {
    return null;
  }
}

export async function getChatByIdAndUserId(id: string, userId: string): Promise<ChatModel | null> {
  try {
    const row = await db.chat.findFirst({ where: { id, user_id: userId } });
    if (!row) return null;
    return chatRowToModel(row as unknown as ChatRow);
  } catch {
    return null;
  }
}

/** Look up a shared chat snapshot by its share token (ChatModel-compatible view). */
export async function getChatByShareId(id: string): Promise<ChatModel | null> {
  try {
    const shared = await getSharedChatById(id);
    if (!shared) return null;
    return {
      id: shared.id,
      user_id: shared.user_id,
      title: shared.title,
      chat: shared.chat,
      created_at: shared.created_at,
      updated_at: shared.updated_at,
      share_id: shared.id,
      archived: false,
      pinned: false,
      meta: {},
      variables: {},
      folder_id: null,
      tasks: null,
      summary: null,
      current_message_id: null,
      last_read_at: null,
      timer_at: null,
    };
  } catch {
    return null;
  }
}

/**
 * Python: get_accessible_chat_by_id — owner, admin read (when
 * ENABLE_ADMIN_CHAT_ACCESS or internal chat), 'continue' shared chat grant,
 * or read/write folder access (write requires share_mode 'continue').
 */
export async function getAccessibleChatById(
  id: string,
  user: { id: string; role: string },
  permission: 'read' | 'write' = 'read',
  chat?: ChatModel | null
): Promise<ChatModel | null> {
  if (user.role !== 'user' && user.role !== 'admin') return null;
  const model = chat !== undefined ? chat : await getChatById(id);
  if (!model) return null;
  if (
    model.user_id === user.id ||
    (user.role === 'admin' && permission === 'read' && (ENABLE_ADMIN_CHAT_ACCESS || isInternalChat(model.meta)))
  ) {
    return model;
  }
  const shared = await getSharedChatByChatId(id);
  if (shared && shared.chat.share_mode === 'continue' && (await hasAccessGrant(user.id, 'shared_chat', id, 'read'))) {
    return model;
  }
  if (model.folder_id) {
    const folder = await getFolderById(model.folder_id);
    if (
      folder &&
      (permission === 'read' || (folder.data ?? {}).share_mode === 'continue') &&
      (await hasFolderAccess(user.id, folder, 'read'))
    ) {
      return model;
    }
  }
  return null;
}

export async function getChatFolderId(id: string, userId: string): Promise<string | null> {
  try {
    const row = await db.chat.findFirst({ where: { id, user_id: userId }, select: { folder_id: true } });
    return row ? row.folder_id : null;
  } catch {
    return null;
  }
}

export async function getInternalChatIdsByParentId(parentChatId: string, userId: string): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT chat.id FROM chat WHERE chat.user_id = ${userId} AND ((NULLIF(chat.meta, '')::jsonb ->> 'internal') IN ('1', 'true', 'True')) AND (NULLIF(chat.meta, '')::jsonb ->> 'parent_chat_id') = ${parentChatId}`
  );
  return rows.map((r) => r.id);
}

export async function getChatTitleById(id: string): Promise<string | null> {
  const row = await db.chat.findUnique({ where: { id }, select: { title: true } });
  if (!row) return null;
  return row.title || 'New Chat';
}

/** Message map for walking history, preferring normalized chat_message rows. */
export async function getMessagesMapByChatId(id: string): Promise<Json | null> {
  const messagesMap = await getChatMessagesMapByChatId(id);
  if (messagesMap !== null) {
    const unresolvedIds = getUnresolvedParentIds(messagesMap);
    if (!unresolvedIds.size) return messagesMap;
    // Graph has gaps — enrich from the legacy embedded history
    const chat = await getChatById(id);
    if (chat) {
      const historyMessages = isObj(chat.chat.history) && isObj(chat.chat.history.messages) ? chat.chat.history.messages : {};
      const missing: Json = {};
      for (const messageId of unresolvedIds) {
        if (messageId in historyMessages) missing[messageId] = historyMessages[messageId];
      }
      if (Object.keys(missing).length) {
        Object.assign(messagesMap, missing);
        await backfillMessagesByChatId(id, chat.user_id, missing);
      }
    }
    return messagesMap;
  }
  const chat = await getChatById(id);
  if (!chat) return null;
  const historyMessages = isObj(chat.chat.history) && isObj(chat.chat.history.messages) ? chat.chat.history.messages : {};
  if (Object.keys(historyMessages).length) {
    await backfillMessagesByChatId(id, chat.user_id, historyMessages);
  }
  return historyMessages;
}

async function backfillMessagesByChatId(chatId: string, userId: string, messages: Json): Promise<void> {
  const writable = Object.entries(messages).filter(([, m]) => isObj(m) && m.role);
  for (const [messageId, message] of writable) {
    try {
      await upsertChatMessage(messageId, chatId, userId, message as Json);
    } catch (e) {
      console.warn(`Backfill failed for chat ${chatId}:`, e);
    }
  }
}

export async function getMessageByIdAndMessageId(id: string, messageId: string): Promise<Json | null> {
  const messagesMap = await getChatMessagesMapByChatId(id);
  if (messagesMap && messageId in messagesMap) return messagesMap[messageId];
  // Messages saved straight into the chat blob have no chat_message row yet
  const row = await db.chat.findUnique({ where: { id }, select: { chat: true } });
  if (!row) return null;
  const chat = parseJsonObj(row.chat);
  const messages = isObj(chat.history) && isObj(chat.history.messages) ? chat.history.messages : {};
  return sanitizeDataForDb(messages[messageId] ?? {});
}

// ---------------------------------------------------------------------------
// Chats: list queries
// ---------------------------------------------------------------------------

export async function getChatListByUserId(
  userId: string,
  includeArchived = false,
  filter: Json | null = null,
  skip = 0,
  limit = 50
): Promise<ChatTitleIdResponse[]> {
  const conds: Prisma.Sql[] = [Prisma.sql`chat.user_id = ${userId}`, INTERNAL_NOT_TRUE];
  if (!includeArchived) conds.push(Prisma.sql`chat.archived = FALSE`);
  const { where, order } = filterOrderSql(filter, true);
  const offsetClause = skip ? Prisma.sql` OFFSET ${skip}` : Prisma.empty;
  const limitClause = limit ? Prisma.sql` LIMIT ${limit}` : Prisma.empty;
  const rows = await db.$queryRaw<any[]>(
    Prisma.sql`SELECT chat.id, chat.title, chat.updated_at, chat.created_at, chat.last_read_at FROM chat WHERE ${Prisma.join(
      conds,
      ' AND '
    )}${where} ${order}${limitClause}${offsetClause}`
  );
  return titleIdRows(rows);
}

export async function getChatTitleIdListByUserId(
  userId: string,
  opts: {
    includeArchived?: boolean;
    includeFolders?: boolean;
    includePinned?: boolean;
    sortBy?: string;
    sortDir?: string;
    skip?: number | null;
    limit?: number | null;
  } = {}
): Promise<ChatTitleIdResponse[]> {
  const {
    includeArchived = false,
    includeFolders = false,
    includePinned = false,
    sortBy = 'updated_at',
    sortDir = 'desc',
    skip = null,
    limit = null,
  } = opts;
  const conds: Prisma.Sql[] = [Prisma.sql`chat.user_id = ${userId}`, INTERNAL_NOT_TRUE];
  if (!includeFolders) conds.push(Prisma.sql`chat.folder_id IS NULL`);
  if (!includePinned) conds.push(Prisma.sql`(chat.pinned = FALSE OR chat.pinned IS NULL)`);
  if (!includeArchived) conds.push(Prisma.sql`chat.archived = FALSE`);
  const order = chatListOrderSql(sortBy, sortDir);
  const offsetClause = skip ? Prisma.sql` OFFSET ${skip}` : Prisma.empty;
  const limitClause = limit ? Prisma.sql` LIMIT ${limit}` : Prisma.empty;
  const rows = await db.$queryRaw<any[]>(
    Prisma.sql`SELECT chat.id, chat.title, chat.updated_at, chat.created_at, chat.last_read_at FROM chat WHERE ${Prisma.join(
      conds,
      ' AND '
    )} ${order}${limitClause}${offsetClause}`
  );
  return titleIdRows(rows);
}

export async function getArchivedChatListByUserId(
  userId: string,
  filter: Json | null = null,
  skip = 0,
  limit = 50
): Promise<ChatTitleIdResponse[]> {
  const conds: Prisma.Sql[] = [Prisma.sql`chat.user_id = ${userId}`, Prisma.sql`chat.archived = TRUE`, INTERNAL_NOT_TRUE];
  const { where, order } = filterOrderSql(filter, true);
  const offsetClause = skip ? Prisma.sql` OFFSET ${skip}` : Prisma.empty;
  const limitClause = limit ? Prisma.sql` LIMIT ${limit}` : Prisma.empty;
  const rows = await db.$queryRaw<any[]>(
    Prisma.sql`SELECT chat.id, chat.title, chat.updated_at, chat.created_at FROM chat WHERE ${Prisma.join(
      conds,
      ' AND '
    )}${where} ${order}${limitClause}${offsetClause}`
  );
  return rows.map((r) => ({
    id: r.id as string,
    title: (r.title ?? '') as string,
    updated_at: (r.updated_at ?? 0) as number,
    created_at: (r.created_at ?? 0) as number,
    last_read_at: null,
    snippet: null,
    active: false,
    archived: false,
  }));
}

export async function countArchivedChatsByUserId(userId: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{ cnt: number }>>(
    Prisma.sql`SELECT COUNT(chat.id) AS cnt FROM chat WHERE chat.user_id = ${userId} AND chat.archived = TRUE AND ${INTERNAL_NOT_TRUE}`
  );
  return rows[0]?.cnt ?? 0;
}

export async function getChatsByUserId(
  userId: string,
  opts: { filter?: Json | null; skip?: number | null; limit?: number | null } = {}
): Promise<ChatListResult> {
  const conds: Prisma.Sql[] = [Prisma.sql`chat.user_id = ${userId}`, INTERNAL_NOT_TRUE];
  let order: Prisma.Sql = Prisma.sql`ORDER BY chat.updated_at DESC, chat.id`;
  const filter = opts.filter;
  if (filter && Object.keys(filter).length) {
    if (filter.updated_at) conds.push(Prisma.sql`chat.updated_at > ${filter.updated_at}`);
    const orderBy = filter.order_by as string | undefined;
    const direction = filter.direction as string | undefined;
    if (orderBy && direction) {
      if (ORDERABLE_CHAT_COLUMNS.includes(orderBy)) {
        const dir = direction.toLowerCase();
        if (dir === 'asc') order = Prisma.sql`ORDER BY chat.${Prisma.raw(orderBy)} ASC, chat.id`;
        else if (dir === 'desc') order = Prisma.sql`ORDER BY chat.${Prisma.raw(orderBy)} DESC, chat.id`;
      }
    }
  }
  const where = Prisma.join(conds, ' AND ');
  const totalRows = await db.$queryRaw<Array<{ cnt: number }>>(
    Prisma.sql`SELECT COUNT(chat.id) AS cnt FROM chat WHERE ${where}`
  );
  const total = totalRows[0]?.cnt ?? 0;
  const offsetClause = opts.skip != null ? Prisma.sql` OFFSET ${opts.skip}` : Prisma.empty;
  const limitClause = opts.limit != null ? Prisma.sql` LIMIT ${opts.limit}` : Prisma.empty;
  const rows = await db.$queryRaw<ChatRow[]>(
    Prisma.sql`SELECT ${CHAT_COLUMNS} FROM chat WHERE ${where} ${order}${limitClause}${offsetClause}`
  );
  return { items: rows.map(chatRowToModel), total };
}

export async function getPinnedChatsByUserId(userId: string): Promise<ChatTitleIdResponse[]> {
  const rows = await db.$queryRaw<any[]>(
    Prisma.sql`SELECT chat.id, chat.title, chat.updated_at, chat.created_at, chat.last_read_at FROM chat WHERE chat.user_id = ${userId} AND chat.pinned = TRUE AND chat.archived = FALSE AND ${INTERNAL_NOT_TRUE} ORDER BY chat.updated_at DESC`
  );
  return titleIdRows(rows);
}

export async function getArchivedChatsByUserId(userId: string): Promise<ChatModel[]> {
  const rows = await db.$queryRaw<ChatRow[]>(
    Prisma.sql`SELECT ${CHAT_COLUMNS} FROM chat WHERE chat.user_id = ${userId} AND chat.archived = TRUE AND ${INTERNAL_NOT_TRUE} ORDER BY chat.updated_at DESC`
  );
  return rows.map(chatRowToModel);
}

/** All non-internal chats in the DB (admin export). */
export async function getChats(): Promise<ChatModel[]> {
  const rows = await db.$queryRaw<ChatRow[]>(
    Prisma.sql`SELECT ${CHAT_COLUMNS} FROM chat WHERE ${INTERNAL_NOT_TRUE} ORDER BY chat.updated_at DESC`
  );
  return rows.map(chatRowToModel);
}

function messageContentMatchSql(param: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    EXISTS (
      SELECT 1 FROM jsonb_each(COALESCE(chat.chat::jsonb -> 'history' -> 'messages', '{}'::jsonb)) AS history_message
      WHERE LOWER(CASE WHEN jsonb_typeof(history_message.value) = 'object' THEN history_message.value ->> 'content' END) LIKE '%' || ${param} || '%'
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_each(COALESCE(chat.chat::jsonb -> 'messages', '[]'::jsonb)) AS legacy_message
      WHERE LOWER(CASE WHEN jsonb_typeof(legacy_message.value) = 'object' THEN legacy_message.value ->> 'content' END) LIKE '%' || ${param} || '%'
    )
  )`;
}

/** Python: get_chats_by_user_id_and_search_text — full search semantics. */
export async function getChatsByUserIdAndSearchText(
  userId: string,
  searchTextRaw: string,
  includeArchived = false,
  skip = 0,
  limit = 60,
  searchFoldersByNamesFn: (userId: string, queries: string[]) => Promise<Array<{ id: string }>> = async () => []
): Promise<ChatTitleIdResponse[]> {
  const searchText = sanitizeTextForDb(searchTextRaw).toLowerCase().trim();
  if (!searchText) {
    return getChatListByUserId(userId, includeArchived, {}, skip, limit);
  }

  let words = searchText.split(/\s+/).filter(Boolean);
  const tagIds = words.filter((w) => w.startsWith('tag:')).map((w) => w.slice(4).replace(/ /g, '_').toLowerCase());
  const folderNames = words.filter((w) => w.startsWith('folder:')).map((w) => w.slice(7));
  const folders = await searchFoldersByNamesFn(userId, folderNames);
  const folderIds = folders.map((f) => f.id);

  let isPinned: boolean | null = null;
  if (words.includes('pinned:true')) isPinned = true;
  else if (words.includes('pinned:false')) isPinned = false;
  let isArchived: boolean | null = null;
  if (words.includes('archived:true')) isArchived = true;
  else if (words.includes('archived:false')) isArchived = false;
  let isShared: boolean | null = null;
  if (words.includes('shared:true')) isShared = true;
  else if (words.includes('shared:false')) isShared = false;

  words = words.filter((w) => !CHAT_SEARCH_FILTER_PREFIXES.some((p) => w.startsWith(w ? p : p)));
  const phraseQuery = words.join(' ').trim();
  const searchTerms = chatSearchTerms(phraseQuery).filter((t) => t !== phraseQuery);

  const conds: Prisma.Sql[] = [Prisma.sql`chat.user_id = ${userId}`, INTERNAL_NOT_TRUE];
  if (isArchived !== null) conds.push(Prisma.sql`chat.archived = ${isArchived}`);
  else if (!includeArchived) conds.push(Prisma.sql`chat.archived = FALSE`);
  if (isPinned !== null) conds.push(Prisma.sql`chat.pinned = ${isPinned}`);
  if (isShared !== null) {
    conds.push(isShared ? Prisma.sql`chat.share_id IS NOT NULL` : Prisma.sql`chat.share_id IS NULL`);
  }
  if (folderNames.length) {
    conds.push(
      folderIds.length
        ? Prisma.sql`chat.folder_id IN (${Prisma.join(folderIds)})`
        : Prisma.sql`chat.folder_id IS NULL AND 1 = 0`
    );
  }

  let exactOrderClause: Prisma.Sql | null = null;
  if (phraseQuery) {
    const exact = Prisma.sql`(LOWER(chat.title) LIKE LOWER(${'%' + phraseQuery + '%'}) OR ${messageContentMatchSql(
      Prisma.sql`${phraseQuery}`
    )})`;
    const termClauses: Prisma.Sql[] = searchTerms.map(
      (term) =>
        Prisma.sql`(LOWER(chat.title) LIKE LOWER(${'%' + term + '%'}) OR ${messageContentMatchSql(Prisma.sql`${term}`)})`
    );
    if (termClauses.length) {
      conds.push(Prisma.sql`(${exact} OR (${Prisma.join(termClauses, ' AND ')}))`);
    } else {
      conds.push(exact);
    }
    exactOrderClause = Prisma.sql`(CASE WHEN ${exact} THEN 0 ELSE 1 END)`;
  }

  if (tagIds.includes('none')) {
    conds.push(
      Prisma.sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(NULLIF(chat.meta, '')::jsonb -> 'tags', '[]'::jsonb)) AS tag)`
    );
  } else {
    for (const tagId of tagIds) {
      conds.push(
        Prisma.sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(NULLIF(chat.meta, '')::jsonb -> 'tags', '[]'::jsonb)) AS tag WHERE tag = ${tagId})`
      );
    }
  }

  const order = exactOrderClause
    ? Prisma.sql`ORDER BY ${exactOrderClause}, chat.updated_at DESC, chat.id`
    : Prisma.sql`ORDER BY chat.updated_at DESC, chat.id`;

  const rows = await db.$queryRaw<any[]>(
    Prisma.sql`SELECT chat.id, chat.title, chat.updated_at, chat.created_at, chat.last_read_at, chat.archived FROM chat WHERE ${Prisma.join(
      conds,
      ' AND '
    )} ${order} LIMIT ${limit} OFFSET ${skip}`
  );
  return rows.map((r) => ({
    id: r.id as string,
    title: (r.title ?? '') as string,
    updated_at: (r.updated_at ?? 0) as number,
    created_at: (r.created_at ?? 0) as number,
    last_read_at: (r.last_read_at ?? null) as number | null,
    snippet: null,
    active: false,
    archived: Boolean(r.archived),
  }));
}

export async function getChatSearchSnippets(
  ids: string[],
  userId: string,
  searchText: string
): Promise<Record<string, string | null>> {
  if (!ids.length || !chatSearchContentQuery(searchText)) return {};
  const rows = await db.$queryRaw<Array<{ id: string; chat: string | null }>>(
    Prisma.sql`SELECT chat.id, chat.chat FROM chat WHERE chat.id IN (${Prisma.join(ids)}) AND chat.user_id = ${userId}`
  );
  const out: Record<string, string | null> = {};
  for (const row of rows) {
    out[row.id] = chatSearchSnippet(parseJsonObj(row.chat), searchText);
  }
  return out;
}

export async function getChatsByFolderIdAndUserId(
  folderId: string,
  userId: string,
  skip = 0,
  limit = 60,
  sortBy = 'updated_at',
  sortDir = 'desc'
): Promise<ChatTitleIdResponse[]> {
  const conds: Prisma.Sql[] = [
    Prisma.sql`chat.folder_id = ${folderId}`,
    Prisma.sql`chat.user_id = ${userId}`,
    Prisma.sql`(chat.pinned = FALSE OR chat.pinned IS NULL)`,
    Prisma.sql`chat.archived = FALSE`,
    INTERNAL_NOT_TRUE,
  ];
  const order = chatListOrderSql(sortBy, sortDir);
  const offsetClause = skip ? Prisma.sql` OFFSET ${skip}` : Prisma.empty;
  const limitClause = limit ? Prisma.sql` LIMIT ${limit}` : Prisma.empty;
  const rows = await db.$queryRaw<any[]>(
    Prisma.sql`SELECT chat.id, chat.title, chat.updated_at, chat.created_at, chat.last_read_at FROM chat WHERE ${Prisma.join(
      conds,
      ' AND '
    )} ${order}${limitClause}${offsetClause}`
  );
  return titleIdRows(rows);
}

/** Get chats in a folder across ALL users. Returns dicts with user_id. */
export async function getAllChatsByFolderId(
  folderId: string,
  skip = 0,
  limit = 60,
  sortBy = 'updated_at',
  sortDir = 'desc',
  unreadForUserId: string | null = null
): Promise<Json[]> {
  const conds: Prisma.Sql[] = [
    Prisma.sql`chat.folder_id = ${folderId}`,
    Prisma.sql`(chat.pinned = FALSE OR chat.pinned IS NULL)`,
    Prisma.sql`chat.archived = FALSE`,
    INTERNAL_NOT_TRUE,
  ];
  const order = chatListOrderSql(sortBy, sortDir, unreadForUserId ?? undefined);
  const offsetClause = skip ? Prisma.sql` OFFSET ${skip}` : Prisma.empty;
  const limitClause = limit ? Prisma.sql` LIMIT ${limit}` : Prisma.empty;
  const rows = await db.$queryRaw<any[]>(
    Prisma.sql`SELECT chat.id, chat.title, chat.user_id, chat.updated_at, chat.created_at, chat.last_read_at FROM chat WHERE ${Prisma.join(
      conds,
      ' AND '
    )} ${order}${limitClause}${offsetClause}`
  );
  return rows.map((r) => ({
    id: r.id as string,
    title: (r.title ?? '') as string,
    user_id: (r.user_id ?? '') as string,
    updated_at: (r.updated_at ?? 0) as number,
    created_at: (r.created_at ?? 0) as number,
    last_read_at: (r.last_read_at ?? null) as number | null,
  }));
}

export async function countAllChatsByFolderId(folderId: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{ cnt: number }>>(
    Prisma.sql`SELECT COUNT(chat.id) AS cnt FROM chat WHERE chat.folder_id = ${folderId} AND (chat.pinned = FALSE OR chat.pinned IS NULL) AND chat.archived = FALSE AND ${INTERNAL_NOT_TRUE}`
  );
  return rows[0]?.cnt ?? 0;
}

export async function getChatsByFolderIdsAndUserId(folderIds: string[], userId: string): Promise<ChatModel[]> {
  if (!folderIds.length) return [];
  const rows = await db.$queryRaw<ChatRow[]>(
    Prisma.sql`SELECT ${CHAT_COLUMNS} FROM chat WHERE chat.folder_id IN (${Prisma.join(
      folderIds
    )}) AND chat.user_id = ${userId} AND (chat.pinned = FALSE OR chat.pinned IS NULL) AND chat.archived = FALSE AND ${INTERNAL_NOT_TRUE} ORDER BY chat.updated_at DESC`
  );
  return rows.map(chatRowToModel);
}

/** Python: get_participant_ids_by_chat_ids — user-message authors per chat. */
export async function getParticipantIdsByChatIds(chatIds: string[]): Promise<Record<string, string[]>> {
  const participants: Record<string, string[]> = {};
  for (const chatId of chatIds) participants[chatId] = [];
  if (!chatIds.length) return participants;

  const rows = await db.$queryRaw<Array<{ chat_id: string; author_id: string }>>(
    Prisma.sql`WITH messages AS (
        SELECT c.id AS chat_id, c.user_id AS owner_id,
               CASE WHEN jsonb_typeof(m.value) = 'object' THEN m.value ELSE '{}'::jsonb END AS message
        FROM chat AS c, jsonb_each(
            CASE
                WHEN jsonb_typeof(c.chat::jsonb -> 'history' -> 'messages') = 'object' THEN c.chat::jsonb -> 'history' -> 'messages'
                WHEN jsonb_typeof(c.chat::jsonb -> 'messages') = 'array' THEN c.chat::jsonb -> 'messages'
                ELSE '[]'::jsonb
            END
        ) AS m
        WHERE c.id IN (${Prisma.join(chatIds)})
      ), authors AS (
        SELECT chat_id, COALESCE(
            CASE WHEN jsonb_typeof(message -> 'user_id') = 'string' AND trim(message ->> 'user_id') <> '' THEN message ->> 'user_id' END,
            CASE WHEN jsonb_typeof(message -> 'user' -> 'id') = 'string' AND trim(message ->> 'user' -> 'id') <> '' THEN message ->> 'user' -> 'id' END,
            NULLIF(trim(owner_id), '')
        ) AS author_id
        FROM messages WHERE message ->> 'role' = 'user'
      )
      SELECT DISTINCT chat_id, author_id FROM authors WHERE author_id IS NOT NULL ORDER BY chat_id, author_id`
  );
  for (const row of rows) participants[row.chat_id]?.push(row.author_id);
  return participants;
}

export async function countUnreadByFolderIds(userId: string, folderIds: string[]): Promise<Record<string, number>> {
  if (!folderIds.length) return {};
  const rows = await db.$queryRaw<Array<{ folder_id: string; cnt: number }>>(
    Prisma.sql`SELECT chat.folder_id, COUNT(chat.id) AS cnt FROM chat WHERE chat.user_id = ${userId} AND chat.folder_id IN (${Prisma.join(
      folderIds
    )}) AND chat.archived = FALSE AND chat.updated_at > COALESCE(chat.last_read_at, 0) AND NOT EXISTS (SELECT 1 FROM chat_message WHERE chat_message.chat_id = chat.id AND chat_message.role = 'assistant' AND chat_message.done IS FALSE) GROUP BY chat.folder_id`
  );
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.folder_id) out[row.folder_id] = Number(row.cnt);
  }
  return out;
}

export async function getChatListByUserIdAndTagName(
  userId: string,
  tagName: string,
  skip = 0,
  limit = 50
): Promise<ChatTitleIdResponse[]> {
  const tagIdVal = String(tagName).replace(/ /g, '_').toLowerCase();
  const offsetClause = skip ? Prisma.sql` OFFSET ${skip}` : Prisma.empty;
  const limitClause = limit ? Prisma.sql` LIMIT ${limit}` : Prisma.empty;
  const rows = await db.$queryRaw<any[]>(
    Prisma.sql`SELECT chat.id, chat.title, chat.updated_at, chat.created_at, chat.last_read_at FROM chat WHERE chat.user_id = ${userId} AND ${INTERNAL_NOT_TRUE} AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(NULLIF(chat.meta, '')::jsonb -> 'tags', '[]'::jsonb)) AS tag WHERE tag = ${tagIdVal}) ORDER BY chat.updated_at DESC, chat.id${limitClause}${offsetClause}`
  );
  return titleIdRows(rows);
}

export async function addChatTagByIdAndUserIdAndTagName(id: string, userId: string, tagName: string): Promise<void> {
  const tagIdVal = tagId(tagName);
  await ensureTagsExist([tagName], userId);
  try {
    const row = await db.chat.findUnique({ where: { id }, select: { meta: true } });
    if (!row) return;
    const meta = parseJsonObj(row.meta);
    const tags: string[] = Array.isArray(meta.tags) ? meta.tags : [];
    if (!tags.includes(tagIdVal)) {
      await db.chat.update({
        where: { id },
        data: { meta: JSON.stringify({ ...meta, tags: [...new Set([...tags, tagIdVal])] }) },
      });
    }
  } catch {
    /* Python swallows exceptions here */
  }
}

export async function countChatsByTagIdsAndUserId(tagIds: string[], userId: string): Promise<Record<string, number>> {
  if (!tagIds.length) return {};
  const selects = tagIds.map((rawTagId, i) => {
    const normalized = String(rawTagId).replace(/ /g, '_').toLowerCase();
    return Prisma.sql`(SELECT COUNT(chat.id) FROM chat WHERE chat.user_id = ${userId} AND ${INTERNAL_NOT_TRUE} AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(NULLIF(chat.meta, '')::jsonb -> 'tags', '[]'::jsonb)) AS tag WHERE tag = ${normalized})) AS ${Prisma.raw(
      `count_${i}`
    )}`;
  });
  const rows = await db.$queryRaw<any[]>(Prisma.sql`SELECT ${Prisma.join(selects)}`);
  const row = rows[0] ?? {};
  const out: Record<string, number> = {};
  tagIds.forEach((rawTagId, i) => {
    out[rawTagId] = Number(row[`count_${i}`] ?? 0);
  });
  return out;
}

export async function countChatsByTagNameAndUserId(tagName: string, userId: string): Promise<number> {
  const counts = await countChatsByTagIdsAndUserId([tagId(tagName)], userId);
  return counts[tagId(tagName)] ?? 0;
}

/** Delete tag rows from tagIds that appear in at most `threshold` chats. */
export async function deleteOrphanTagsForUser(
  tagIds: string[],
  userId: string,
  threshold = 0
): Promise<void> {
  if (!tagIds.length) return;
  const counts = await countChatsByTagIdsAndUserId(tagIds, userId);
  const orphans = tagIds.filter((t) => (counts[t] ?? 0) <= threshold);
  await deleteTagsByIdsAndUserId(orphans, userId);
}

export async function deleteTagByIdAndUserIdAndTagName(id: string, userId: string, tagName: string): Promise<boolean> {
  try {
    const row = await db.chat.findUnique({ where: { id }, select: { meta: true } });
    if (!row) return false;
    const meta = parseJsonObj(row.meta);
    const tags: string[] = Array.isArray(meta.tags) ? meta.tags : [];
    const tagIdVal = tagId(tagName);
    const remaining = tags.filter((t) => t !== tagIdVal);
    await db.chat.update({
      where: { id },
      data: { meta: JSON.stringify({ ...meta, tags: [...new Set(remaining)] }) },
    });
    return true;
  } catch {
    return false;
  }
}

export async function countChatsByFolderIdAndUserId(folderId: string, userId: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{ cnt: number }>>(
    Prisma.sql`SELECT COUNT(chat.id) AS cnt FROM chat WHERE chat.user_id = ${userId} AND chat.folder_id = ${folderId} AND ${INTERNAL_NOT_TRUE}`
  );
  return rows[0]?.cnt ?? 0;
}

export async function countChatsByFolderIdsAndUserId(folderIds: string[], userId: string): Promise<number> {
  if (!folderIds.length) return 0;
  const rows = await db.$queryRaw<Array<{ cnt: number }>>(
    Prisma.sql`SELECT COUNT(chat.id) AS cnt FROM chat WHERE chat.user_id = ${userId} AND chat.folder_id IN (${Prisma.join(
      folderIds
    )}) AND ${INTERNAL_NOT_TRUE}`
  );
  return rows[0]?.cnt ?? 0;
}

// ---------------------------------------------------------------------------
// Chats: deletes
// ---------------------------------------------------------------------------

export async function deleteChatById(id: string): Promise<boolean> {
  try {
    await db.automationRun.updateMany({ where: { chat_id: id }, data: { chat_id: null } });
    await db.chatMessage.deleteMany({ where: { chat_id: id } });
    await db.chat.delete({ where: { id } });
    return true && (await deleteSharedChatByChatId(id));
  } catch (e) {
    console.error('delete_chat_by_id:', e);
    return false;
  }
}

export async function deleteChatByIdAndUserId(id: string, userId: string): Promise<boolean> {
  try {
    await db.automationRun.updateMany({ where: { chat_id: id }, data: { chat_id: null } });
    await db.chatMessage.deleteMany({ where: { chat_id: id } });
    await db.chat.deleteMany({ where: { id, user_id: userId } });
    return true && (await deleteSharedChatByChatId(id));
  } catch (e) {
    console.error('delete_chat_by_id_and_user_id:', e);
    return false;
  }
}

export async function deleteChatsByUserId(userId: string): Promise<boolean> {
  try {
    await deleteSharedChatsByUserId(userId);
    const chatIds = await db.chat.findMany({ where: { user_id: userId }, select: { id: true } });
    await db.automationRun.updateMany({
      where: { chat_id: { in: chatIds.map((c) => c.id) } },
      data: { chat_id: null },
    });
    await db.chatMessage.deleteMany({ where: { chat_id: { in: chatIds.map((c) => c.id) } } });
    await db.chat.deleteMany({ where: { user_id: userId } });
    return true;
  } catch (e) {
    console.error('delete_chats_by_user_id:', e);
    return false;
  }
}

export async function deleteChatsByUserIdAndFolderId(userId: string, folderId: string): Promise<boolean> {
  try {
    const chatIds = await db.chat.findMany({
      where: { user_id: userId, folder_id: folderId },
      select: { id: true },
    });
    const ids = chatIds.map((c) => c.id);
    await db.automationRun.updateMany({ where: { chat_id: { in: ids } }, data: { chat_id: null } });
    await db.chatMessage.deleteMany({ where: { chat_id: { in: ids } } });
    await db.sharedChat.deleteMany({ where: { chat_id: { in: ids } } });
    await db.chat.deleteMany({ where: { user_id: userId, folder_id: folderId } });
    return true;
  } catch (e) {
    console.error('delete_chats_by_user_id_and_folder_id:', e);
    return false;
  }
}

export async function moveChatsByFolderId(folderId: string, newFolderId: string | null): Promise<boolean> {
  try {
    await db.chat.updateMany({ where: { folder_id: folderId }, data: { folder_id: newFolderId } });
    return true;
  } catch {
    return false;
  }
}

export async function deleteSharedChatsByUserId(userId: string): Promise<boolean> {
  try {
    await db.sharedChat.deleteMany({ where: { user_id: userId } });
    await db.chat.updateMany({ where: { user_id: userId }, data: { share_id: null } });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Namespace objects (mirror the Python repository singletons)
// ---------------------------------------------------------------------------

export const ChatMessages = {
  upsertMessage: upsertChatMessage,
  getMessagesMapByChatId: getChatMessagesMapByChatId,
  hasUnfinishedAssistantByChatId,
  deleteMessageIdsByChatId,
};

export const Tags = {
  getTagByNameAndUserId,
  getTagsByUserId,
  getTagsByIdsAndUserId,
  deleteTagByNameAndUserId,
  deleteTagsByIdsAndUserId,
  ensureTagsExist,
};

export const SharedChats = {
  create: createSharedChat,
  update: updateSharedChat,
  setShareMode: setSharedChatShareMode,
  getById: getSharedChatById,
  getByChatId: getSharedChatByChatId,
  getByUserId: getSharedChatsByUserId,
  deleteById: deleteSharedChatById,
  deleteByChatId: deleteSharedChatByChatId,
  deleteAllByUserId: deleteAllSharedChatsByUserId,
};

export const AccessGrants = {
  getGrantsByResource,
  setAccessGrants,
  revokeAllAccess,
  hasAnyoneAccess,
  normalize: normalizeAccessGrants,
  validate: validateAccessGrants,
};
