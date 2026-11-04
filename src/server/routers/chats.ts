import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { configGet, configSet } from '@/lib/config';
import { ERROR_MESSAGES } from '@/lib/constants';
import { hasPermission } from '@/lib/access-control';
import {
  ENABLE_ADMIN_CHAT_ACCESS,
  ENABLE_ADMIN_EXPORT,
  userPermissionsConfig,
  ChatModel,
  ChatForm,
  ChatImportForm,
  SharedChatModel,
  getMessageList,
  getMessagesMapByChatId,
  insertNewChat,
  importChats,
  updateChatById,
  updateChatParamsById,
  updateChatVariablesById,
  markChatUnreadById,
  markChatsReadByUserId,
  updateChatShareIdById,
  toggleChatPinnedById,
  toggleChatArchiveById,
  archiveAllChatsByUserId,
  unarchiveAllChatsByUserId,
  updateChatFolderIdByIdAndUserId,
  upsertMessageToChatByIdAndMessageId,
  deleteMessageFromChatByIdAndMessageId,
  getChatById,
  getChatByIdAndUserId,
  getChatByShareId,
  getAccessibleChatById,
  getChatFolderId,
  getInternalChatIdsByParentId,
  getChatListByUserId,
  getChatTitleIdListByUserId,
  getArchivedChatListByUserId,
  countArchivedChatsByUserId,
  getChatsByUserId,
  getPinnedChatsByUserId,
  getArchivedChatsByUserId,
  getChats,
  getChatsByUserIdAndSearchText,
  getChatSearchSnippets,
  getChatsByFolderIdAndUserId,
  getChatsByFolderIdsAndUserId,
  countUnreadByFolderIds,
  getChatListByUserIdAndTagName,
  addChatTagByIdAndUserIdAndTagName,
  countChatsByTagNameAndUserId,
  deleteOrphanTagsForUser,
  deleteTagByIdAndUserIdAndTagName,
  deleteChatById,
  deleteChatByIdAndUserId,
  deleteChatsByUserId,
  getMessageByIdAndMessageId,
  createSharedChat,
  updateSharedChat,
  setSharedChatShareMode,
  getSharedChatById,
  getSharedChatByChatId,
  getSharedChatsByUserId,
  deleteSharedChatByChatId,
  deleteAllSharedChatsByUserId,
  getGrantsByResource,
  setAccessGrants,
  hasAnyoneAccess,
  validateAccessGrants,
  getTagsByUserId,
  getTagByNameAndUserId,
  deleteTagByNameAndUserId,
  ensureTagsExist,
  getTagsByIdsAndUserId,
} from '@/lib/models/chats';
import {
  getFolderByIdAndUserId,
  getFoldersByUserId,
  getChildrenFoldersByIdAndUserId,
  hasFolderAccess,
  hasFolderWriteAccess,
  hasChatMoveAccess,
  searchFoldersByNames,
} from '@/lib/models/folders';
import { Users } from '@/lib/models/users';

/**
 * Port of open_webui/routers/chats.py (v0.12.5) — /api/v1/chats/*.
 *
 * Deviations (runtime capabilities absent in this deployment):
 *  • publish_event / get_event_emitter / refresh_chat_access are no-ops
 *    (no socket/event-bus runtime) — POST /{id}/messages/{mid}/event
 *    returns false like Python does when no emitter exists.
 *  • has_active_tasks (Redis) is always false: `active` flags stay false and
 *    the 409 "wait for the current response" guards never trigger.
 *  • get_response_streams_by_chat_id (Redis) returns [] — in-flight message
 *    overlay is a no-op.
 *  • stop_item_tasks (Redis) is a no-op.
 *  • Context-compaction summary generation calls the model backend directly
 *    (resolveModelRoute) instead of generate_chat_completion; the prompt
 *    template substitution is a simplified {{token}} replacement.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const envBool = (key: string, def: string) => (process.env[key] ?? def).toLowerCase() === 'true';
const envInt = (key: string, def: number | null): number | null => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
};

const DEFAULT_ERROR = (msg = ''): string => (msg ? `[ERROR: ${msg}]` : 'Something went wrong :/');

const CHAT_EXPORT_BATCH_SIZE = 100;
const CHAT_EXPORT_PAGE_ITEM_COUNT = 10;

function err(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

function requireUser(ctx: Ctx) {
  const user = ctx.user;
  if (!user) err(401, ERROR_MESSAGES.NOT_AUTHENTICATED);
  if (!['user', 'admin'].includes(user.role)) err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
  return user;
}

function requireAdmin(ctx: Ctx) {
  const user = ctx.user;
  if (!user) err(401, ERROR_MESSAGES.NOT_AUTHENTICATED);
  if (user.role !== 'admin') err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
  return user;
}

function queryInt(ctx: Ctx, name: string, fallback: number | null): number | null {
  const raw = ctx.query.get(name);
  if (raw === null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function queryBool(value: string | null): boolean {
  return value !== null && /^(true|1|yes|on)$/i.test(value);
}

const isObj = (v: any): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** ChatResponse.model_dump — fixed field set (context_usage defaults null). */
function chatResponse(chat: ChatModel): Record<string, any> {
  return {
    id: chat.id,
    user_id: chat.user_id,
    title: chat.title,
    chat: structuredClone(chat.chat ?? {}),
    updated_at: chat.updated_at,
    created_at: chat.created_at,
    share_id: chat.share_id ?? null,
    archived: chat.archived ?? false,
    pinned: chat.pinned ?? false,
    meta: chat.meta ?? {},
    variables: chat.variables ?? {},
    folder_id: chat.folder_id ?? null,
    tasks: chat.tasks ?? null,
    summary: chat.summary ?? null,
    current_message_id: chat.current_message_id ?? null,
    context_usage: null,
  };
}

/** Python: get_message_list — root-first ordering. */
function messageListRootFirst(messagesMap: Record<string, any> | null | undefined, messageId: string | null | undefined): any[] {
  return [...getMessageList(messagesMap, messageId)].reverse();
}

/** Python: set_message_authors — attribute client messages to the user. */
function setMessageAuthors(chat: Record<string, any>, user: { id: string; name: string }): void {
  const messages = [
    ...Object.values(chat?.history?.messages ?? {}),
    ...(Array.isArray(chat?.messages) ? chat.messages : []),
  ];
  for (const message of messages) {
    if (!isObj(message)) continue;
    message.user_id = user.id;
    if (message.role === 'user') message.user = { id: user.id, name: user.name };
  }
}

/** Python: add_active_state_to_chat_list — active stays false (no task runtime). */
function addActiveStateToChatList<T extends { active: boolean }>(chats: T[]): T[] {
  return chats.map((chat) => ({ ...chat, active: false }));
}

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

/** Python: require_chat_import_permission */
async function requireChatImportPermission(user: { id: string; role: string }): Promise<void> {
  if (user.role !== 'admin') {
    const permissions = await userPermissionsConfig();
    if (!(await hasPermission(user.id, 'chat.import', permissions))) {
      err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared chat helpers (routers/chats.py)
// ---------------------------------------------------------------------------

async function isOpenSharedChat(shared: SharedChatModel): Promise<boolean> {
  return hasAnyoneAccess('shared_chat', shared.chat_id, 'read');
}

async function canReadSharedChat(user: { id: string; role: string }, shared: SharedChatModel): Promise<boolean> {
  if (user.role === 'pending') return false;
  if (user.role === 'admin' && ENABLE_ADMIN_CHAT_ACCESS) return true;
  if (shared.user_id === user.id) return true;
  const { hasAccessGrant } = await import('@/lib/access-control');
  return hasAccessGrant(user.id, 'shared_chat', shared.chat_id, 'read');
}

/** Python: shared_chat_response — author attribution + privacy scrubbing. */
async function sharedChatResponse(
  chat: ChatModel,
  user: { id: string; name: string } | null
): Promise<Record<string, any>> {
  const data = chatResponse(chat);
  if (user === null || chat.user_id !== user.id) {
    data.variables = {};
    for (const key of ['params', 'tool_servers', 'tool_ids', 'filter_ids', 'variables']) {
      delete data.chat[key];
    }
  }

  const messages = [
    ...Object.values(data.chat?.history?.messages ?? {}),
    ...(Array.isArray(data.chat?.messages) ? data.chat.messages : []),
  ];
  const authors: Record<string, { id: string; name: string }> = {};
  for (const message of messages) {
    if (!isObj(message)) continue;
    if (message.role === 'user') {
      const author = isObj(message.user) ? message.user : {};
      const authorId = message.user_id || author.id || chat.user_id;
      message.user_id = authorId;
      if (author.id === authorId && author.name) {
        authors[authorId] = { id: authorId, name: author.name };
      }
    }
    if (user === null || (message.user_id ?? chat.user_id) !== user.id) {
      delete message.meta;
    }
  }
  const missingIds = new Set<string>();
  for (const message of messages) {
    if (isObj(message) && message.role === 'user' && message.user_id) missingIds.add(message.user_id);
  }
  for (const id of Object.keys(authors)) missingIds.delete(id);
  if (missingIds.size) {
    for (const author of await Users.getUsersByUserIds([...missingIds])) {
      authors[author.id] = { id: author.id, name: author.name };
    }
  }
  for (const message of messages) {
    if (isObj(message) && message.role === 'user') {
      message.user = authors[message.user_id] ?? { id: message.user_id, name: '' };
    }
  }
  return data;
}

/** GET /share/{share_id} core (reused by POST /{id}/fork). */
async function getSharedChatHandlerData(
  shareId: string,
  user: { id: string; name: string; role: string } | null
): Promise<Record<string, any>> {
  const shared = await getSharedChatById(shareId);
  if (shared) {
    if (
      (await isOpenSharedChat(shared)) ||
      (user !== null && (await canReadSharedChat(user, shared)))
    ) {
      const live =
        shared.chat.share_mode === 'continue' &&
        user !== null &&
        (await getAccessibleChatById(shared.chat_id, user, 'write')) !== null;
      const chat = live ? await getChatById(shared.chat_id) : await getChatByShareId(shareId);
      if (chat) {
        const data = await sharedChatResponse(chat, user);
        data.chat.share_mode = live ? 'continue' : null;
        return data;
      }
    }
    err(
      401,
      user ? ERROR_MESSAGES.ACCESS_PROHIBITED : ERROR_MESSAGES.INVALID_TOKEN
    );
  }

  // Fallback: admins can also access any chat directly by chat ID
  if (user !== null && user.role === 'admin' && ENABLE_ADMIN_CHAT_ACCESS) {
    const chat = await getChatById(shareId);
    if (chat) {
      const data = await sharedChatResponse(chat, user);
      data.chat.share_mode =
        (await getAccessibleChatById(chat.id, user, 'write', chat)) !== null ? 'continue' : null;
      return data;
    }
  }

  err(401, ERROR_MESSAGES.NOT_FOUND);
}

/** Rebuild a ChatModel-like object from a processed ChatResponse dict. */
function chatFromResponseData(data: Record<string, any>): ChatModel {
  return {
    id: data.id,
    user_id: data.user_id,
    title: data.title ?? '',
    chat: data.chat ?? {},
    created_at: data.created_at ?? 0,
    updated_at: data.updated_at ?? 0,
    share_id: data.share_id ?? null,
    archived: Boolean(data.archived),
    pinned: data.pinned ?? null,
    meta: data.meta ?? {},
    variables: data.variables ?? {},
    folder_id: data.folder_id ?? null,
    tasks: data.tasks ?? null,
    summary: data.summary ?? null,
    current_message_id: data.current_message_id ?? null,
    last_read_at: data.last_read_at ?? null,
    timer_at: data.timer_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Context compaction (utils/context_compaction.py)
// ---------------------------------------------------------------------------

const BASE64_DATA_URI_RE = /data:[\w/+.;=%-]*;base64,[A-Za-z0-9+/=]*/g;

const DEFAULT_CONTEXT_COMPACTION_PROMPT = `### Task:
Summarize the conversation history that will be compacted out of the active chat context.

### Instructions:
- Preserve key decisions, user preferences, and constraints.
- Preserve files, artifacts, tool results, and code changes that matter going forward.
- Preserve the current task state, unresolved questions, and next steps.
- Be factual and specific. Do not invent details.
- Keep the summary concise, but complete enough for the assistant to continue without the removed messages.

### Previous Summary:
{{PREVIOUS_SUMMARY}}

### Messages Being Compacted:
{{COMPACTED_MESSAGES}}

### Recent Messages Kept In Context:
{{RECENT_MESSAGES}}`;

function parsePositiveInt(value: any): number | null {
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function clampRetentionPercentage(value: any): number {
  const n = parseInt(String(value), 10);
  const parsed = Number.isFinite(n) ? n : 40;
  return Math.min(50, Math.max(10, parsed));
}

async function loadCompactionConfig() {
  const tokenThreshold =
    parsePositiveInt(
      await configGet<any>('chat.context_compaction.token_threshold', envInt('CONTEXT_COMPACTION_TOKEN_THRESHOLD', 80000))
    ) ?? 80000;
  return {
    enable: await configGet<boolean>('chat.context_compaction.enable', envBool('ENABLE_CONTEXT_COMPACTION', 'False')),
    tokenThreshold,
    tokenCap:
      parsePositiveInt(
        await configGet<any>('chat.context_compaction.token_cap', envInt('CONTEXT_COMPACTION_TOKEN_CAP', null))
      ) ?? tokenThreshold,
    retentionPercentage: clampRetentionPercentage(
      await configGet<any>('chat.context_compaction.retention_percentage', envInt('CONTEXT_COMPACTION_RETENTION_PERCENTAGE', 40))
    ),
    promptTemplate:
      (await configGet<string>('chat.context_compaction.prompt_template', process.env.CONTEXT_COMPACTION_PROMPT_TEMPLATE ?? '')) ?? '',
  };
}

function resolveTokenThreshold(globalThreshold: number, globalCap: number, metadata: Record<string, any>): number {
  const configured = parsePositiveInt((metadata.params ?? {}).compact_token_threshold);
  return Math.min(configured ?? globalThreshold, globalCap);
}

function usageTokenCount(usage: Record<string, any>): number {
  let promptTokens = Number(usage.prompt_tokens || usage.prompt_eval_count || 0) || 0;
  if (!promptTokens && (usage.prompt_n != null || usage.cache_n != null)) {
    promptTokens = (Number(usage.prompt_n) || 0) + (Number(usage.cache_n) || 0);
  }
  if (!promptTokens) promptTokens = Number(usage.input_tokens) || 0;
  const completionTokens =
    Number(usage.completion_tokens || usage.output_tokens || usage.eval_count || usage.predicted_n || 0) || 0;
  return promptTokens + completionTokens;
}

function estimateTokens(value: any): number {
  if (value === null || value === undefined) return 0;
  if (typeof value !== 'string') {
    try {
      value = JSON.stringify(value);
    } catch {
      value = String(value);
    }
  }
  if (!value) return 0;
  return Math.max(1, Math.floor(value.length / 4));
}

function estimateMessagesTokens(messages: any[]): number {
  let total = 0;
  for (const message of messages ?? []) {
    if (!isObj(message)) continue;
    total += 4;
    const content = message.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!isObj(item)) total += estimateTokens(item);
        else if (item.type === 'image' || item.type === 'image_url') total += 1000;
        else total += estimateTokens(item.text ?? item.content ?? item);
      }
    } else {
      total += estimateTokens(content);
    }
    total += estimateTokens(message.output);
    total += estimateTokens(message.tool_calls);
    if (message.files) {
      total += estimateTokens(JSON.stringify(message.files).replace(BASE64_DATA_URI_RE, ''));
    }
  }
  return total;
}

function buildContextUsage(tokens: number, threshold: number): Record<string, any> {
  return {
    tokens,
    estimated_tokens: tokens,
    threshold,
    percent: threshold > 0 ? Math.round((tokens / threshold) * 100) : 0,
    source: 'estimated',
  };
}

/** Python: _apply_latest_summary_checkpoint — operates on root-first lists. */
function applyLatestSummaryCheckpoint(messages: any[]): [any[], string | null] {
  for (let idx = messages.length - 1; idx >= 0; idx--) {
    const message = isObj(messages[idx]) ? messages[idx] : {};
    const value = message.contextSummary ?? message.context_summary;
    if (typeof value === 'string' && value.trim()) {
      return [messages.slice(idx), value];
    }

    const output = Array.isArray(message.output) ? message.output : [];
    let marker: Record<string, any> | undefined;
    for (let i = output.length - 1; i >= 0; i--) {
      if (isObj(output[i]) && output[i].type === 'open_webui:context_compaction') {
        marker = output[i];
        break;
      }
    }
    if (!marker) continue;

    // A tool-loop checkpoint can retain output from an earlier reply.
    for (let cutIdx = idx; cutIdx >= 0; cutIdx--) {
      const cutOutput = Array.isArray(messages[cutIdx]?.output) ? messages[cutIdx].output : [];
      let start = cutOutput.findIndex(
        (item: any) => isObj(item) && item.type === 'function_call' && item.call_id === marker.call_id
      );
      if (start !== -1) {
        while (start > 0 && cutOutput[start - 1]?.type !== 'function_call_output') start -= 1;
        return [
          [
            ...messages.slice(Math.max(0, cutIdx - 1), cutIdx),
            {
              ...messages[cutIdx],
              output: cutOutput.slice(start).filter((item: any) => item?.type !== 'open_webui:context_compaction'),
            },
            ...messages.slice(cutIdx + 1),
          ],
          typeof marker.summary === 'string' ? marker.summary : null,
        ];
      }
    }
  }
  return [messages, null];
}

async function getChatContextUsage(
  chat: ChatModel,
  modelId: string | null = null
): Promise<Record<string, any> | null> {
  const chatData = chat.chat ?? {};
  const history = chatData.history ?? {};
  let currentId: string | null | undefined = chat.current_message_id || history.currentId;
  if (!currentId) currentId = chatData.currentId || chatData.branchPointMessageId;
  if (!currentId && Array.isArray(chatData.messages) && chatData.messages.length) {
    const last = chatData.messages[chatData.messages.length - 1];
    currentId = isObj(last) ? last.id : null;
  }
  if (!currentId) return null;

  const messagesMap = await getMessagesMapByChatId(chat.id);
  const messages = messageListRootFirst(messagesMap || history.messages || {}, currentId);
  if (!messages.length) return null;

  const config = await loadCompactionConfig();
  if (!config.enable) return null;

  const params = { ...(chat.chat?.params ?? {}) };
  if (modelId) params.model = modelId;
  const threshold = resolveTokenThreshold(config.tokenThreshold, config.tokenCap, { params });
  const [filtered, previousSummary] = applyLatestSummaryCheckpoint(messages);

  for (let idx = filtered.length - 1; idx >= 0; idx--) {
    const message = isObj(filtered[idx]) ? filtered[idx] : {};
    const usage = message.usage ?? (isObj(message.info) ? message.info.usage : null);
    if (isObj(usage)) {
      const tokens = usageTokenCount(usage);
      if (tokens) {
        return buildContextUsage(tokens + estimateMessagesTokens(filtered.slice(idx + 1)), threshold);
      }
    }
  }

  const tokens = estimateTokens(previousSummary ?? '') + estimateMessagesTokens(filtered);
  return buildContextUsage(tokens, threshold);
}

// ---------------------------------------------------------------------------
// Compaction summary generation (simplified generate_chat_completion path)
// ---------------------------------------------------------------------------

function getContentFromMessage(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((item) => isObj(item) && item.type === 'text')
      .map((item) => String(item.text ?? ''))
      .join('');
  }
  return '';
}

function serializeMessagesForPrompt(messages: any[]): string {
  return (messages ?? [])
    .map((message) => `${(message?.role ?? 'unknown').toUpperCase()}: ${getContentFromMessage(message)}`)
    .join('\n');
}

async function generateSummary(
  user: { id: string; name: string },
  modelId: string,
  compactedMessages: any[],
  recentMessages: any[],
  previousSummary: string | null,
  summaryPromptTemplate: string
): Promise<string> {
  const { resolveModelRoute } = await import('@/lib/models-registry');
  const contextCompactionModel = await configGet<string | null>(
    'chat.context_compaction.model',
    process.env.CONTEXT_COMPACTION_MODEL ?? ''
  );
  let taskModelId = contextCompactionModel || modelId;
  let route = await resolveModelRoute(taskModelId);
  if (!route && taskModelId !== modelId) {
    taskModelId = modelId;
    route = await resolveModelRoute(taskModelId);
  }
  if (!route) {
    throw new HttpError(500, DEFAULT_ERROR());
  }

  const allMessages = [...compactedMessages, ...recentMessages];
  const lastUser =
    [...allMessages].reverse().find((message) => isObj(message) && message.role === 'user') ?? null;

  const template = summaryPromptTemplate.trim() || DEFAULT_CONTEXT_COMPACTION_PROMPT;
  const prompt = template
    .replaceAll('{{prompt}}', getContentFromMessage(lastUser) || '')
    .replaceAll('{{PREVIOUS_SUMMARY}}', previousSummary ?? '')
    .replaceAll('{{COMPACTED_MESSAGES}}', serializeMessagesForPrompt(compactedMessages))
    .replaceAll('{{RECENT_MESSAGES}}', serializeMessagesForPrompt(recentMessages))
    .replaceAll('{{USER_NAME}}', user.name);

  let taskModelParams = await configGet<Record<string, any> | null>('task.model.params', null);
  if (!isObj(taskModelParams)) taskModelParams = {};
  const params: Record<string, any> = {};
  for (const [key, value] of Object.entries(taskModelParams)) {
    if (value !== null && value !== '') params[key] = value;
  }
  if (!Object.keys(params).length) params.max_tokens = 1000;

  const body: Record<string, any> = { model: route.model, messages: [{ role: 'user', content: prompt }], ...params };
  const url = route.type === 'openai' ? `${route.baseUrl}/chat/completions` : `${route.baseUrl}/api/chat`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (route.type === 'openai' && route.apiKey) headers.authorization = `Bearer ${route.apiKey}`;
  if (route.type !== 'openai') {
    body.stream = false;
    body.options = { num_predict: body.max_tokens };
  }

  let summary = '';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (response.ok) {
      const data: any = await response.json();
      if (route.type === 'openai') {
        summary = String(data?.choices?.[0]?.message?.content ?? '');
      } else {
        summary = String(data?.message?.content ?? '');
      }
    }
  } catch {
    summary = '';
  }
  summary = summary.trim();
  if (summary) return summary;

  const parts: string[] = previousSummary ? [previousSummary] : [];
  for (const message of compactedMessages) {
    const content = getContentFromMessage(message);
    if (content) parts.push(`- ${message?.role ?? 'unknown'}: ${content.slice(0, 500)}`);
  }
  return parts.join('\n').slice(0, 4000);
}

async function compactChatBranch(
  user: { id: string; name: string },
  chat: ChatModel,
  modelId: string
): Promise<Record<string, any>> {
  const config = await loadCompactionConfig();
  if (!config.enable) return { ok: true, compacted: false, reason: 'disabled' };

  const chatData = chat.chat ?? {};
  const history = chatData.history ?? {};
  let currentId: string | null = chat.current_message_id || history.currentId || null;
  if (!currentId) currentId = chatData.currentId || chatData.branchPointMessageId || null;
  if (!currentId && Array.isArray(chatData.messages) && chatData.messages.length) {
    const last = chatData.messages[chatData.messages.length - 1];
    currentId = isObj(last) ? (last.id ?? null) : null;
  }
  if (!currentId) return { ok: true, compacted: false, reason: 'empty' };

  let messagesMap = await getMessagesMapByChatId(chat.id);
  if (!messagesMap) messagesMap = history.messages ?? {};

  const [messages, previousSummary] = applyLatestSummaryCheckpoint(
    messageListRootFirst(messagesMap, currentId)
  );
  const compactedMessages = messages.slice(0, -1);
  const recentMessages = messages.slice(-1);
  if (!compactedMessages.length || !recentMessages.length) {
    return { ok: true, compacted: false, reason: 'too_short' };
  }

  const summary = await generateSummary(
    user,
    modelId,
    compactedMessages,
    recentMessages,
    previousSummary,
    config.promptTemplate
  );
  await upsertMessageToChatByIdAndMessageId(chat.id, currentId, { contextSummary: summary }, false);

  return {
    ok: true,
    compacted: true,
    dropped_messages: compactedMessages.length,
    kept_messages: recentMessages.length,
    summary_chars: summary.length,
  };
}

// ---------------------------------------------------------------------------
// Chat fork (utils/chat_fork.py)
// ---------------------------------------------------------------------------

function buildForkHistory(messagesMap: Record<string, any>, sourceMessageId: string): [Record<string, any>, any[]] {
  if (!messagesMap || !Object.keys(messagesMap).length) {
    throw new HttpError(400, 'chat has no messages to fork');
  }

  const branch: Array<[string, Record<string, any>]> = [];
  const seen = new Set<string>();
  let messageId: string | null = sourceMessageId;

  while (messageId) {
    if (seen.has(messageId)) throw new HttpError(400, 'message branch contains a cycle');
    seen.add(messageId);

    const message = messagesMap[messageId];
    if (!isObj(message)) throw new HttpError(404, 'message not found');

    branch.push([messageId, message]);
    messageId = typeof message.parentId === 'string' ? message.parentId : null;
  }

  const forkMessages: Record<string, any> = {};
  const orderedMessages: any[] = [];
  let parentId: string | null = null;

  for (const [id, message] of [...branch].reverse()) {
    const copied = structuredClone(message);
    copied.id = id;
    copied.parentId = parentId;
    copied.childrenIds = [];

    if (parentId) forkMessages[parentId].childrenIds = [id];

    forkMessages[id] = copied;
    orderedMessages.push(copied);
    parentId = id;
  }

  return [{ messages: forkMessages, currentId: sourceMessageId }, orderedMessages];
}

// ---------------------------------------------------------------------------
// Chat config (CHAT_CONFIG_KEYS)
// ---------------------------------------------------------------------------

const CHAT_CONFIG_KEYS: Record<string, string> = {
  CONTEXT_COMPACTION_MODEL: 'chat.context_compaction.model',
  ENABLE_CONTEXT_COMPACTION: 'chat.context_compaction.enable',
  CONTEXT_COMPACTION_TOKEN_THRESHOLD: 'chat.context_compaction.token_threshold',
  CONTEXT_COMPACTION_TOKEN_CAP: 'chat.context_compaction.token_cap',
  CONTEXT_COMPACTION_RETENTION_PERCENTAGE: 'chat.context_compaction.retention_percentage',
  CONTEXT_COMPACTION_PROMPT_TEMPLATE: 'chat.context_compaction.prompt_template',
  ENABLE_TOOL_PERMISSIONS: 'chat.tool_permissions.enable',
  ENABLE_TOOL_SEARCH: 'chat.tool_search.enable',
  TOOL_SEARCH_DEFER_THRESHOLD: 'chat.tool_search.defer_threshold',
  TOOL_SEARCH_ALWAYS_LOADED: 'chat.tool_search.always_loaded',
  TOOL_SEARCH_DEFER_BUILTIN_TOOLS: 'chat.tool_search.defer_builtin_tools',
};

async function getChatConfigValues(): Promise<Record<string, any>> {
  const values: Record<string, any> = {
    CONTEXT_COMPACTION_MODEL: await configGet<any>('chat.context_compaction.model', process.env.CONTEXT_COMPACTION_MODEL ?? ''),
    ENABLE_CONTEXT_COMPACTION: await configGet<any>('chat.context_compaction.enable', envBool('ENABLE_CONTEXT_COMPACTION', 'False')),
    CONTEXT_COMPACTION_TOKEN_THRESHOLD: await configGet<any>('chat.context_compaction.token_threshold', envInt('CONTEXT_COMPACTION_TOKEN_THRESHOLD', 80000)),
    CONTEXT_COMPACTION_TOKEN_CAP: await configGet<any>('chat.context_compaction.token_cap', envInt('CONTEXT_COMPACTION_TOKEN_CAP', null)),
    CONTEXT_COMPACTION_RETENTION_PERCENTAGE: await configGet<any>('chat.context_compaction.retention_percentage', envInt('CONTEXT_COMPACTION_RETENTION_PERCENTAGE', 40)),
    CONTEXT_COMPACTION_PROMPT_TEMPLATE: await configGet<any>('chat.context_compaction.prompt_template', process.env.CONTEXT_COMPACTION_PROMPT_TEMPLATE ?? ''),
    ENABLE_TOOL_PERMISSIONS: await configGet<any>('chat.tool_permissions.enable', envBool('ENABLE_TOOL_PERMISSIONS', 'False')),
    ENABLE_TOOL_SEARCH: await configGet<any>('chat.tool_search.enable', envBool('ENABLE_TOOL_SEARCH', 'False')),
    TOOL_SEARCH_DEFER_THRESHOLD: await configGet<any>('chat.tool_search.defer_threshold', envInt('TOOL_SEARCH_DEFER_THRESHOLD', 400)),
    TOOL_SEARCH_ALWAYS_LOADED: await configGet<any>('chat.tool_search.always_loaded', (process.env.TOOL_SEARCH_ALWAYS_LOADED ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    TOOL_SEARCH_DEFER_BUILTIN_TOOLS: await configGet<any>('chat.tool_search.defer_builtin_tools', envBool('TOOL_SEARCH_DEFER_BUILTIN_TOOLS', 'True')),
  };

  const config: Record<string, any> = {};
  for (const [field, storageKey] of Object.entries(CHAT_CONFIG_KEYS)) {
    if (storageKey in values) config[field] = values[storageKey];
  }
  if (config.CONTEXT_COMPACTION_MODEL == null) config.CONTEXT_COMPACTION_MODEL = '';
  if (config.CONTEXT_COMPACTION_TOKEN_CAP == null) {
    config.CONTEXT_COMPACTION_TOKEN_CAP = config.CONTEXT_COMPACTION_TOKEN_THRESHOLD ?? 80000;
  }
  if (config.CONTEXT_COMPACTION_RETENTION_PERCENTAGE == null) {
    config.CONTEXT_COMPACTION_RETENTION_PERCENTAGE = 40;
  }
  return config;
}

// ---------------------------------------------------------------------------
// Stats export (_process_chat_for_export)
// ---------------------------------------------------------------------------

function getMessageContentLength(message: Record<string, any>): number {
  const content = message.content ?? '';
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content
      .filter((item) => isObj(item) && item.type === 'text')
      .reduce((sum, item) => sum + String(item.text ?? '').length, 0);
  }
  return 0;
}

function processChatForExport(chat: ChatModel): Record<string, any> | null {
  try {
    const messagesMap = chat.chat?.history?.messages ?? {};
    const messageId = chat.chat?.history?.currentId ?? null;

    const historyModels: Record<string, number> = {};
    const historyMessageCount = Object.keys(messagesMap).length;
    const historyUserMessages: any[] = [];
    const historyAssistantMessages: any[] = [];

    const exportMessages: Record<string, any> = {};
    for (const [key, raw] of Object.entries(messagesMap)) {
      const message = isObj(raw) ? raw : {};
      try {
        const contentLength = getMessageContentLength(message);
        const annotation = isObj(message.annotation) ? message.annotation : {};
        const rating = annotation.rating ?? null;
        const tags = annotation.tags ?? null;

        exportMessages[key] = {
          id: message.id ?? null,
          role: message.role ?? null,
          model: message.model ?? null,
          timestamp: message.timestamp ?? null,
          content_length: contentLength,
          token_count: null,
          rating,
          tags,
        };

        const role = message.role ?? '';
        if (role === 'user') historyUserMessages.push(message);
        else if (role === 'assistant') {
          historyAssistantMessages.push(message);
          const model = message.model;
          if (model) historyModels[model] = (historyModels[model] ?? 0) + 1;
        }
      } catch {
        continue;
      }
    }

    const averageUserMessageContentLength = historyUserMessages.length
      ? historyUserMessages.reduce((sum, m) => sum + getMessageContentLength(m), 0) / historyUserMessages.length
      : 0;
    const averageAssistantMessageContentLength = historyAssistantMessages.length
      ? historyAssistantMessages.reduce((sum, m) => sum + getMessageContentLength(m), 0) / historyAssistantMessages.length
      : 0;

    const responseTimes: number[] = [];
    for (const message of historyAssistantMessages) {
      const userMessageId = message.parentId ?? null;
      if (userMessageId && userMessageId in messagesMap) {
        const userMessage = messagesMap[userMessageId];
        const t1 = message.timestamp;
        const t0 = isObj(userMessage) ? userMessage.timestamp : null;
        if (t1 && t0) responseTimes.push(t1 - t0);
      }
    }
    const averageResponseTime = responseTimes.length
      ? responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length
      : 0;

    const messageList = messageListRootFirst(messagesMap, messageId);
    const messageCount = messageList.length;
    const models: Record<string, number> = {};
    for (let i = messageList.length - 1; i >= 0; i--) {
      const message = isObj(messageList[i]) ? messageList[i] : {};
      if (message.role === 'assistant') {
        const model = message.model;
        if (model) models[model] = (models[model] ?? 0) + 1;
      }
    }

    return {
      id: chat.id,
      user_id: chat.user_id,
      created_at: chat.created_at,
      updated_at: chat.updated_at,
      tags: chat.meta?.tags ?? [],
      stats: {
        average_response_time: averageResponseTime,
        average_user_message_content_length: averageUserMessageContentLength,
        average_assistant_message_content_length: averageAssistantMessageContentLength,
        models,
        message_count: messageCount,
        history_models: historyModels,
        history_message_count: historyMessageCount,
        history_user_message_count: historyUserMessages.length,
        history_assistant_message_count: historyAssistantMessages.length,
      },
      chat: { history: { messages: exportMessages, currentId: messageId } },
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// NDJSON streaming helpers
// ---------------------------------------------------------------------------

function ndjsonResponse(chunks: string[], filename?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/x-ndjson' };
  if (filename) headers['content-disposition'] = `attachment; filename=${filename}`;
  return new Response(chunks.join(''), { status: 200, headers });
}

async function collectChatExportNdjson(userId: string): Promise<string[]> {
  const lines: string[] = [];
  let skip = 0;
  for (;;) {
    const result = await getChatsByUserId(userId, { skip, limit: CHAT_EXPORT_BATCH_SIZE });
    if (!result.items.length) break;
    for (const chat of result.items) {
      try {
        lines.push(`${JSON.stringify(chatResponse(chat))}\n`);
      } catch {
        /* skip malformed chat */
      }
    }
    if (result.items.length < CHAT_EXPORT_BATCH_SIZE) break;
    skip += CHAT_EXPORT_BATCH_SIZE;
  }
  return lines;
}

async function collectChatStatsNdjson(userId: string, filter: Record<string, any>): Promise<string[]> {
  const lines: string[] = [];
  let skip = 0;
  for (;;) {
    const result = await getChatsByUserId(userId, { filter, skip, limit: CHAT_EXPORT_PAGE_ITEM_COUNT });
    if (!result.items.length) break;
    for (const chat of result.items) {
      const chatStat = processChatForExport(chat);
      if (chatStat) lines.push(`${JSON.stringify(chatStat)}\n`);
    }
    skip += CHAT_EXPORT_PAGE_ITEM_COUNT;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // GET /  +  GET /list — session user chat list
  {
    method: 'GET',
    path: '',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      try {
        const page = queryInt(ctx, 'page', null);
        const includePinned = queryBool(ctx.query.get('include_pinned'));
        const includeFolders = queryBool(ctx.query.get('include_folders'));
        const sortBy = ctx.query.get('sort_by') ?? 'updated_at';
        const sortDir = ctx.query.get('sort_dir') ?? 'desc';

        let chats;
        if (page !== null) {
          const limit = 60;
          const skip = (page - 1) * limit;
          chats = await getChatTitleIdListByUserId(user.id, {
            includeFolders,
            includePinned,
            sortBy,
            sortDir,
            skip,
            limit,
          });
        } else {
          chats = await getChatTitleIdListByUserId(user.id, {
            includeFolders,
            includePinned,
            sortBy,
            sortDir,
          });
        }
        return ctx.json(addActiveStateToChatList(chats));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, DEFAULT_ERROR());
      }
    },
  },
  {
    method: 'GET',
    path: 'list',
    auth: 'user',
    handler: async (ctx) => routes[0].handler(ctx),
  },

  // POST /read — mark all chats read
  {
    method: 'POST',
    path: 'read',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      return ctx.json({
        updated_count: await markChatsReadByUserId(user.id),
        folder_unread_counts: await getFolderUnreadCounts(user.id),
      });
    },
  },

  // GET /stats/usage — per-chat usage stats
  {
    method: 'GET',
    path: 'stats/usage',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      try {
        const itemsPerPage = queryInt(ctx, 'items_per_page', 50) ?? 50;
        const page = queryInt(ctx, 'page', 1) ?? 1;
        const skip = (page - 1) * itemsPerPage;

        const result = await getChatsByUserId(user.id, { skip, limit: itemsPerPage });
        const chatStats: Record<string, any>[] = [];

        for (const chat of result.items) {
          const messagesMap = chat.chat?.history?.messages ?? {};
          const messageId = chat.chat?.history?.currentId ?? null;

          if (Object.keys(messagesMap).length && messageId) {
            try {
              const historyModels: Record<string, number> = {};
              const historyMessageCount = Object.keys(messagesMap).length;
              const historyUserMessages: any[] = [];
              const historyAssistantMessages: any[] = [];

              for (const raw of Object.values(messagesMap)) {
                const message = isObj(raw) ? raw : {};
                if (message.role === 'user') historyUserMessages.push(message);
                else if (message.role === 'assistant') {
                  historyAssistantMessages.push(message);
                  const model = message.model;
                  if (model) historyModels[model] = (historyModels[model] ?? 0) + 1;
                }
              }

              const averageUserMessageContentLength = historyUserMessages.length
                ? historyUserMessages.reduce((sum, m) => sum + getMessageContentLength(m), 0) / historyUserMessages.length
                : 0;
              const averageAssistantMessageContentLength = historyAssistantMessages.length
                ? historyAssistantMessages.reduce((sum, m) => sum + getMessageContentLength(m), 0) / historyAssistantMessages.length
                : 0;

              const responseTimes: number[] = [];
              for (const message of historyAssistantMessages) {
                const userMessageId = message.parentId ?? null;
                if (userMessageId && userMessageId in messagesMap) {
                  const userMessage = messagesMap[userMessageId];
                  responseTimes.push(
                    (message.timestamp ?? 0) - (isObj(userMessage) ? (userMessage.timestamp ?? 0) : 0)
                  );
                }
              }
              const averageResponseTime = responseTimes.length
                ? responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length
                : 0;

              const messageList = messageListRootFirst(messagesMap, messageId);
              const messageCount = messageList.length;

              const models: Record<string, number> = {};
              for (let i = messageList.length - 1; i >= 0; i--) {
                const message = isObj(messageList[i]) ? messageList[i] : {};
                if (message.role === 'assistant') {
                  const model = message.model;
                  if (model) models[model] = (models[model] ?? 0) + 1;
                }
              }

              chatStats.push({
                id: chat.id,
                models,
                message_count: messageCount,
                history_models: historyModels,
                history_message_count: historyMessageCount,
                history_user_message_count: historyUserMessages.length,
                history_assistant_message_count: historyAssistantMessages.length,
                average_response_time: averageResponseTime,
                average_user_message_content_length: averageUserMessageContentLength,
                average_assistant_message_content_length: averageAssistantMessageContentLength,
                tags: chat.meta?.tags ?? [],
                last_message_at: messageList.length
                  ? (isObj(messageList[messageList.length - 1]) ? messageList[messageList.length - 1].timestamp ?? null : null)
                  : null,
                updated_at: chat.updated_at,
                created_at: chat.created_at,
              });
            } catch {
              /* skip malformed chat */
            }
          }
        }

        return ctx.json({ items: chatStats, total: result.total });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, DEFAULT_ERROR());
      }
    },
  },

  // GET /stats/export — export chat stats (paged or NDJSON stream)
  {
    method: 'GET',
    path: 'stats/export',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      if (user.role !== 'admin' && !(await configGet<boolean>('ui.enable_community_sharing', false))) {
        err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      try {
        const updatedAt = queryInt(ctx, 'updated_at', null);
        const page = queryInt(ctx, 'page', 1) ?? 1;
        const stream = queryBool(ctx.query.get('stream'));

        const filter: Record<string, any> = { order_by: 'updated_at', direction: 'asc' };
        if (updatedAt) filter.updated_at = updatedAt;

        if (stream) {
          const lines = await collectChatStatsNdjson(user.id, filter);
          return ndjsonResponse(lines, `chat-stats-export-${user.id}.jsonl`);
        }

        const limit = CHAT_EXPORT_PAGE_ITEM_COUNT;
        const skip = (page - 1) * limit;
        const result = await getChatsByUserId(user.id, { filter, skip, limit });
        const items = result.items
          .map((chat) => processChatForExport(chat))
          .filter((item): item is Record<string, any> => item !== null);

        return ctx.json({ type: 'chats', items, total: result.total, page });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, DEFAULT_ERROR());
      }
    },
  },

  // GET /stats/export/{chat_id} — single chat stats export
  {
    method: 'GET',
    path: 'stats/export/:chat_id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      if (user.role !== 'admin' && !(await configGet<boolean>('ui.enable_community_sharing', false))) {
        err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const chat = await getChatById(ctx.params.chat_id);
      if (!chat) err(404, ERROR_MESSAGES.NOT_FOUND);

      if (chat.user_id !== user.id && !(user.role === 'admin' && ENABLE_ADMIN_CHAT_ACCESS)) {
        err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const chatStats = processChatForExport(chat);
      if (!chatStats) err(400, 'Failed to process chat stats');
      return ctx.json(chatStats);
    },
  },

  // DELETE / — delete all session user chats
  {
    method: 'DELETE',
    path: '',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      if (user.role === 'user') {
        const permissions = await userPermissionsConfig();
        if (!(await hasPermission(user.id, 'chat.delete', permissions))) {
          err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
        }
      }

      const tags = await getTagsByUserId(user.id);
      const result = await deleteChatsByUserId(user.id);
      if (result) {
        await deleteOrphanTagsForUser(tags.map((tag) => tag.id), user.id);
      }
      return ctx.json(result);
    },
  },

  // GET /list/user/{user_id} — admin listing of a user's chats
  {
    method: 'GET',
    path: 'list/user/:user_id',
    auth: 'admin',
    handler: async (ctx) => {
      requireAdmin(ctx);
      if (!ENABLE_ADMIN_CHAT_ACCESS) err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);

      const page = queryInt(ctx, 'page', 1) ?? 1;
      const limit = 60;
      const skip = (page - 1) * limit;

      const filter: Record<string, any> = {};
      const query = ctx.query.get('query');
      if (query) filter.query = query;
      const orderBy = ctx.query.get('order_by');
      if (orderBy) filter.order_by = orderBy;
      const direction = ctx.query.get('direction');
      if (direction) filter.direction = direction;

      const chats = await getChatListByUserId(ctx.params.user_id, true, filter, skip, limit);
      return ctx.json(addActiveStateToChatList(chats));
    },
  },

  // POST /new — create a chat
  {
    method: 'POST',
    path: 'new',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const form = await ctx.body<{ chat?: Record<string, any>; variables?: Record<string, any> | null; folder_id?: string | null }>();

      if (form.folder_id != null && !(await hasFolderWriteAccess(user.id, form.folder_id))) {
        err(404, ERROR_MESSAGES.NOT_FOUND);
      }

      try {
        const chatForm: ChatForm = {
          chat: isObj(form.chat) ? form.chat : {},
          variables: form.variables ?? null,
          folder_id: form.folder_id ?? null,
        };
        setMessageAuthors(chatForm.chat, user);
        const chat = await insertNewChat(crypto.randomUUID(), user.id, chatForm);
        if (!chat) err(400, DEFAULT_ERROR());
        return ctx.json(chatResponse(chat));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, DEFAULT_ERROR());
      }
    },
  },

  // POST /import — import chats
  {
    method: 'POST',
    path: 'import',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await requireChatImportPermission(user);

      try {
        const form = await ctx.body<{ chats?: any[] }>();
        const chatForms: ChatImportForm[] = (Array.isArray(form.chats) ? form.chats : []).map((chatForm) => ({
          chat: isObj(chatForm?.chat) ? chatForm.chat : {},
          variables: chatForm?.variables ?? null,
          folder_id: chatForm?.folder_id ?? null,
          meta: chatForm?.meta ?? null,
          pinned: chatForm?.pinned ?? null,
          archived: chatForm?.archived ?? null,
          current_message_id: chatForm?.current_message_id ?? null,
          created_at: chatForm?.created_at ?? null,
          updated_at: chatForm?.updated_at ?? null,
        }));
        for (const chatForm of chatForms) {
          setMessageAuthors(chatForm.chat, user);
        }
        const chats = await importChats(user.id, chatForms);

        const tagIds = new Set<string>();
        for (const chat of chats) {
          for (const tagId of chat.meta?.tags ?? []) tagIds.add(tagId);
        }
        await ensureTagsExist([...tagIds], user.id);

        return ctx.json(chats.map((chat) => chatResponse(chat)));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, DEFAULT_ERROR());
      }
    },
  },

  // GET /config — chat config (admin)
  {
    method: 'GET',
    path: 'config',
    auth: 'admin',
    handler: async (ctx) => {
      requireAdmin(ctx);
      return ctx.json(await getChatConfigValues());
    },
  },

  // POST /config — update chat config (admin)
  {
    method: 'POST',
    path: 'config',
    auth: 'admin',
    handler: async (ctx) => {
      requireAdmin(ctx);
      const form = await ctx.body<Record<string, any>>();

      let threshold = form.CONTEXT_COMPACTION_TOKEN_THRESHOLD ?? null;
      if (threshold === null || threshold === undefined) {
        threshold = envInt('CONTEXT_COMPACTION_TOKEN_THRESHOLD', 80000);
      }
      threshold = Math.max(1, parseInt(String(threshold), 10) || 1);
      const tokenCap = Math.max(1, parseInt(String(form.CONTEXT_COMPACTION_TOKEN_CAP || threshold), 10) || 1);
      let retentionPercentage = form.CONTEXT_COMPACTION_RETENTION_PERCENTAGE ?? null;
      if (retentionPercentage === null || retentionPercentage === undefined) {
        retentionPercentage = envInt('CONTEXT_COMPACTION_RETENTION_PERCENTAGE', 40);
      }
      retentionPercentage = Math.min(50, Math.max(10, parseInt(String(retentionPercentage), 10) || 40));
      const toolSearchDeferThreshold = Math.max(0, parseInt(String(form.TOOL_SEARCH_DEFER_THRESHOLD ?? 400), 10) || 0);
      const toolSearchAlwaysLoaded = (Array.isArray(form.TOOL_SEARCH_ALWAYS_LOADED) ? form.TOOL_SEARCH_ALWAYS_LOADED : [])
        .map((item: any) => String(item ?? '').trim())
        .filter(Boolean);

      const updates: Record<string, any> = {
        ...form,
        CONTEXT_COMPACTION_MODEL: form.CONTEXT_COMPACTION_MODEL || '',
        CONTEXT_COMPACTION_TOKEN_THRESHOLD: threshold,
        CONTEXT_COMPACTION_TOKEN_CAP: tokenCap,
        CONTEXT_COMPACTION_RETENTION_PERCENTAGE: retentionPercentage,
        TOOL_SEARCH_DEFER_THRESHOLD: toolSearchDeferThreshold,
        TOOL_SEARCH_ALWAYS_LOADED: toolSearchAlwaysLoaded,
      };
      const toUpsert: Record<string, any> = {};
      for (const [field, value] of Object.entries(updates)) {
        if (field in CHAT_CONFIG_KEYS) toUpsert[CHAT_CONFIG_KEYS[field]] = value;
      }
      for (const storageKey of Object.values(toUpsert).length ? Object.keys(toUpsert) : []) {
        await configSet(storageKey, toUpsert[storageKey]);
      }
      return ctx.json(await getChatConfigValues());
    },
  },

  // GET /search — search session user chats
  {
    method: 'GET',
    path: 'search',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const text = ctx.query.get('text');
      if (text === null) err(422, "Field required: 'text'");
      const page = queryInt(ctx, 'page', 1) ?? 1;
      const limit = 60;
      const skip = (page - 1) * limit;

      const chatList = await getChatsByUserIdAndSearchText(
        user.id,
        text,
        false,
        skip,
        limit,
        searchFoldersByNames
      );

      // Delete the tag when no chat is found
      const words = text.trim().split(' ');
      if (page === 1 && words.length === 1 && words[0].startsWith('tag:')) {
        const tagId = words[0].replace('tag:', '');
        if (
          chatList.length === 0 &&
          (await countChatsByTagNameAndUserId(tagId, user.id)) === 0 &&
          (await getTagByNameAndUserId(tagId, user.id))
        ) {
          await deleteTagByNameAndUserId(tagId, user.id);
        }
      }

      return ctx.json(addActiveStateToChatList(chatList));
    },
  },

  // GET /folder/{folder_id} — chats inside a folder (full models)
  {
    method: 'GET',
    path: 'folder/:folder_id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const folderIds = [ctx.params.folder_id];
      const children = await getChildrenFoldersByIdAndUserId(ctx.params.folder_id, user.id);
      if (children) folderIds.push(...children.map((folder) => folder.id));

      const chats = await getChatsByFolderIdsAndUserId(folderIds, user.id);
      return ctx.json(chats.map((chat) => chatResponse(chat)));
    },
  },

  // GET /folder/{folder_id}/list — chat list inside a folder
  {
    method: 'GET',
    path: 'folder/:folder_id/list',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      try {
        const page = queryInt(ctx, 'page', 1) ?? 1;
        const limit = 10;
        const skip = (page - 1) * limit;
        const sortBy = ctx.query.get('sort_by') ?? 'unread_updated_at';
        const sortDir = ctx.query.get('sort_dir') ?? 'desc';

        const chats = await getChatsByFolderIdAndUserId(ctx.params.folder_id, user.id, skip, limit, sortBy, sortDir);
        return ctx.json(addActiveStateToChatList(chats));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, DEFAULT_ERROR());
      }
    },
  },

  // GET /pinned — pinned chats
  {
    method: 'GET',
    path: 'pinned',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const chats = await getPinnedChatsByUserId(user.id);
      return ctx.json(addActiveStateToChatList(chats));
    },
  },

  // GET /all — all session user chats as NDJSON
  {
    method: 'GET',
    path: 'all',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const lines = await collectChatExportNdjson(user.id);
      return ndjsonResponse(lines);
    },
  },

  // GET /all/archived — archived chats (full models)
  {
    method: 'GET',
    path: 'all/archived',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const chats = await getArchivedChatsByUserId(user.id);
      return ctx.json(chats.map((chat) => chatResponse(chat)));
    },
  },

  // GET /all/tags — all user tags
  {
    method: 'GET',
    path: 'all/tags',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      try {
        return ctx.json(await getTagsByUserId(user.id));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, DEFAULT_ERROR());
      }
    },
  },

  // GET /all/db — all chats in the DB (admin)
  {
    method: 'GET',
    path: 'all/db',
    auth: 'admin',
    handler: async (ctx) => {
      requireAdmin(ctx);
      if (!ENABLE_ADMIN_EXPORT) err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      const chats = await getChats();
      return ctx.json(chats.map((chat) => chatResponse(chat)));
    },
  },

  // GET /archived — archived chat list
  {
    method: 'GET',
    path: 'archived',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const page = queryInt(ctx, 'page', 1) ?? 1;
      const limit = 60;
      const skip = (page - 1) * limit;

      const filter: Record<string, any> = {};
      const query = ctx.query.get('query');
      if (query) filter.query = query;
      const orderBy = ctx.query.get('order_by');
      if (orderBy) filter.order_by = orderBy;
      const direction = ctx.query.get('direction');
      if (direction) filter.direction = direction;

      const chats = await getArchivedChatListByUserId(user.id, filter, skip, limit);
      return ctx.json(addActiveStateToChatList(chats));
    },
  },

  // GET /archived/count — archived chat count
  {
    method: 'GET',
    path: 'archived/count',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      return ctx.json(await countArchivedChatsByUserId(user.id));
    },
  },

  // POST /archive/all — archive all chats
  {
    method: 'POST',
    path: 'archive/all',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      return ctx.json(await archiveAllChatsByUserId(user.id));
    },
  },

  // POST /unarchive/all — unarchive all chats
  {
    method: 'POST',
    path: 'unarchive/all',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const tagIds = new Set<string>();
      for (const chat of await getArchivedChatsByUserId(user.id)) {
        for (const tagId of chat.meta?.tags ?? []) tagIds.add(tagId);
      }
      const result = await unarchiveAllChatsByUserId(user.id);
      if (result) {
        await ensureTagsExist([...tagIds], user.id);
      }
      return ctx.json(result);
    },
  },

  // DELETE /share/all — unshare all chats
  {
    method: 'DELETE',
    path: 'share/all',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const sharedList = await getSharedChatsByUserId(user.id, {}, 0, 50);
      const chatIds = sharedList.map((s) => s.chat_id);

      const result = await deleteAllSharedChatsByUserId(user.id);

      for (const chatId of chatIds) {
        await updateChatShareIdById(chatId, null);
        await setAccessGrants('shared_chat', chatId, []);
      }
      return ctx.json(result);
    },
  },

  // GET /shared — shared chat list for the session user
  {
    method: 'GET',
    path: 'shared',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const page = queryInt(ctx, 'page', 1) ?? 1;
      const limit = 60;
      const skip = (page - 1) * limit;

      const filter: Record<string, any> = {};
      const query = ctx.query.get('query');
      if (query) filter.query = query;
      const orderBy = ctx.query.get('order_by');
      if (orderBy) filter.order_by = orderBy;
      const direction = ctx.query.get('direction');
      if (direction) filter.direction = direction;

      return ctx.json(await getSharedChatsByUserId(user.id, filter, skip, limit));
    },
  },

  // GET /share/{share_id} — public shared chat snapshot
  {
    method: 'GET',
    path: 'share/:share_id',
    auth: 'optional',
    handler: async (ctx) => {
      const user =
        ctx.user && ['user', 'admin'].includes(ctx.user.role)
          ? ctx.user
          : null;
      const data = await getSharedChatHandlerData(ctx.params.share_id, user);
      return ctx.json(data);
    },
  },

  // POST /tags — chat list by tag name
  {
    method: 'POST',
    path: 'tags',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const form = await ctx.body<{ name?: string; skip?: number; limit?: number }>();
      const name = typeof form.name === 'string' ? form.name : '';
      const skip = form.skip ?? 0;
      const limit = form.limit ?? 50;

      const chats = await getChatListByUserIdAndTagName(user.id, name, skip, limit);
      if (chats.length === 0) {
        await deleteTagByNameAndUserId(name, user.id);
      }
      return ctx.json(addActiveStateToChatList(chats));
    },
  },

  // POST /shared/{id}/access/update — update shared chat grants
  {
    method: 'POST',
    path: 'shared/:id/access/update',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;

      const chat =
        user.role === 'admin' && ENABLE_ADMIN_CHAT_ACCESS
          ? await getChatById(id)
          : await getChatByIdAndUserId(id, user.id);
      if (!chat) err(404, ERROR_MESSAGES.NOT_FOUND);

      const form = await ctx.body<{ access_grants?: any[]; share_mode?: string | null }>();
      const grants = await validateAccessGrants(
        await userPermissionsConfig(),
        user.id,
        user.role,
        form.access_grants ?? [],
        'shared_chat'
      );

      await setAccessGrants('shared_chat', id, grants);
      if ('share_mode' in (form ?? {}) && chat.share_id) {
        await setSharedChatShareMode(chat.share_id, form.share_mode ?? null);
      }
      return ctx.json(chatResponse(chat));
    },
  },

  // GET /shared/{id}/access — list shared chat grants
  {
    method: 'GET',
    path: 'shared/:id/access',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;

      const chat =
        user.role === 'admin' && ENABLE_ADMIN_CHAT_ACCESS
          ? await getChatById(id)
          : await getChatByIdAndUserId(id, user.id);
      if (!chat) err(404, ERROR_MESSAGES.NOT_FOUND);

      const grants = await getGrantsByResource('shared_chat', id);
      return ctx.json(
        grants.map((g) => ({
          id: g.id,
          principal_type: g.principal_type,
          principal_id: g.principal_id,
          permission: g.permission,
        }))
      );
    },
  },

  // POST /{id}/compact — compact the chat context
  {
    method: 'POST',
    path: ':id/compact',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const chat = await getChatByIdAndUserId(ctx.params.id, user.id);
      if (!chat) err(401, ERROR_MESSAGES.NOT_FOUND);

      const form = await ctx.body<{ model?: string | null }>().catch(() => ({}) as { model?: string | null });

      const history = chat.chat?.history ?? {};
      const messagesMap = await getMessagesMapByChatId(chat.id);
      const currentMessageId = chat.current_message_id || history.currentId || null;
      const messageList = messageListRootFirst(messagesMap || history.messages || {}, currentMessageId);

      let modelId = form?.model || null;
      if (!modelId) {
        for (let i = 0; i < messageList.length; i++) {
          const message = isObj(messageList[i]) ? messageList[i] : {};
          if (message.model) {
            modelId = message.model;
            break;
          }
        }
      }
      if (!modelId) {
        const chatModels = Array.isArray(chat.chat?.models) ? chat.chat.models : [];
        modelId = chatModels[0] ?? null;
      }
      if (!modelId) err(400, 'No model found for context compaction.');

      const result = await compactChatBranch(user, chat, modelId);
      const contextUsage = await getChatContextUsage(chat, modelId);
      result.context_usage = contextUsage;
      return ctx.json(result);
    },
  },

  // GET /{id} — chat detail (access-controlled)
  {
    method: 'GET',
    path: ':id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const chat = await getAccessibleChatById(ctx.params.id, user);

      if (chat) {
        const data = await sharedChatResponse(chat, user);
        data.chat.share_mode =
          (await getAccessibleChatById(chat.id, user, 'write', chat)) !== null ? 'continue' : null;
        data.context_usage = await getChatContextUsage(chat);
        return ctx.json(data);
      }
      err(401, ERROR_MESSAGES.NOT_FOUND);
    },
  },

  // POST /{id} — update a chat
  {
    method: 'POST',
    path: ':id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const form = await ctx.body<{
        chat?: Record<string, any>;
        variables?: Record<string, any> | null;
        folder_id?: string | null;
      }>();
      const chatFormChat = isObj(form.chat) ? form.chat : {};

      const existing = await getChatById(id);
      if (existing && existing.user_id !== user.id) {
        const folder = existing.folder_id
          ? await getFolderByIdAndUserId(existing.folder_id, user.id)
          : null;
        if (
          !folder ||
          new Set(Object.keys(chatFormChat)).size !== 1 ||
          !('title' in chatFormChat) ||
          form.variables !== null && form.variables !== undefined ||
          form.folder_id !== null && form.folder_id !== undefined
        ) {
          err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
        }
        const title = chatFormChat.title;
        if (typeof title !== 'string' || !title.trim()) {
          err(400, DEFAULT_ERROR('Invalid title'));
        }
        chatFormChat.title = title.trim();
      }

      if (existing) {
        setMessageAuthors(chatFormChat, user);
        const touch = 'history' in chatFormChat || 'messages' in chatFormChat;
        let chat = await updateChatById(id, chatFormChat, touch);
        if (form.variables !== null && form.variables !== undefined) {
          chat = (await updateChatVariablesById(id, form.variables, false)) ?? chat;
        }
        if (!chat) err(500, DEFAULT_ERROR());

        if (chat.user_id !== user.id) {
          return ctx.json(await sharedChatResponse(chat, user));
        }
        return ctx.json(chatResponse(chat));
      }
      err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
    },
  },

  // PATCH /{id}/params — merge chat params
  {
    method: 'PATCH',
    path: ':id/params',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      if (!(await getChatByIdAndUserId(id, user.id))) {
        err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const form = await ctx.body<Record<string, any>>();
      const chat = await updateChatParamsById(id, isObj(form) ? form : {});
      if (chat === null) err(404, ERROR_MESSAGES.NOT_FOUND);
      return ctx.json(chat.chat?.params ?? {});
    },
  },

  // POST /{id}/messages/{message_id} — update a message
  {
    method: 'POST',
    path: ':id/messages/:message_id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const messageId = ctx.params.message_id;

      const chat = await getChatById(id);
      if (!chat) err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      if (chat.user_id !== user.id && !(user.role === 'admin' && ENABLE_ADMIN_CHAT_ACCESS)) {
        err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const form = await ctx.body<{ content?: string | null; voice?: Record<string, any> | null }>();
      const updates: Record<string, any> = {};
      if (form.content !== null && form.content !== undefined) {
        updates.content = form.content;
      }
      if (form.voice !== null && form.voice !== undefined) {
        if (JSON.stringify(form.voice).length > 100000) {
          err(400, 'Voice metadata is too large');
        }
        if (!(await getMessageByIdAndMessageId(id, messageId))) {
          err(404, ERROR_MESSAGES.NOT_FOUND);
        }
        updates.meta = { voice: form.voice };
      }
      if (!Object.keys(updates).length) {
        err(400, 'No message changes supplied');
      }
      const updated = await upsertMessageToChatByIdAndMessageId(id, messageId, updates);
      if (!updated) err(500, DEFAULT_ERROR());
      return ctx.json(chatResponse(updated));
    },
  },

  // DELETE /{id}/messages/{message_id} — delete a message
  {
    method: 'DELETE',
    path: ':id/messages/:message_id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const messageId = ctx.params.message_id;

      const chat = await getChatById(id);
      if (!chat) err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      if (chat.user_id !== user.id && !(user.role === 'admin' && ENABLE_ADMIN_CHAT_ACCESS)) {
        err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const updated = await deleteMessageFromChatByIdAndMessageId(id, messageId);
      if (!updated) err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      return ctx.json(chatResponse(updated));
    },
  },

  // POST /{id}/messages/{message_id}/event — emit a message event (no socket runtime)
  {
    method: 'POST',
    path: ':id/messages/:message_id/event',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;

      const chat = await getChatById(id);
      if (!chat) err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      if (chat.user_id !== user.id && !(user.role === 'admin' && ENABLE_ADMIN_CHAT_ACCESS)) {
        err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }
      return ctx.json(false);
    },
  },

  // DELETE /{id} — delete a chat
  {
    method: 'DELETE',
    path: ':id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;

      let chat: ChatModel | null;
      if (user.role === 'admin') {
        chat = await getChatById(id);
        if (chat && chat.user_id !== user.id && !ENABLE_ADMIN_CHAT_ACCESS) chat = null;
      } else {
        const permissions = await userPermissionsConfig();
        if (!(await hasPermission(user.id, 'chat.delete', permissions))) {
          err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
        }
        chat = await getChatByIdAndUserId(id, user.id);
      }

      if (!chat) err(404, ERROR_MESSAGES.NOT_FOUND);

      await deleteOrphanTagsForUser(chat.meta?.tags ?? [], chat.user_id, 1);

      // Cascade to internal child chats spawned from this one.
      for (const childId of await getInternalChatIdsByParentId(id, chat.user_id)) {
        await deleteChatByIdAndUserId(childId, chat.user_id);
      }

      const result =
        user.role === 'admin'
          ? await deleteChatById(id)
          : await deleteChatByIdAndUserId(id, user.id);
      return ctx.json(result);
    },
  },

  // GET /{id}/pinned — pinned status
  {
    method: 'GET',
    path: ':id/pinned',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const chat = await getChatByIdAndUserId(ctx.params.id, user.id);
      if (chat) return ctx.json(chat.pinned ?? null);
      err(401, DEFAULT_ERROR());
    },
  },

  // POST /{id}/pin — toggle pin
  {
    method: 'POST',
    path: ':id/pin',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const chat = await getChatByIdAndUserId(ctx.params.id, user.id);
      if (chat) {
        const updated = await toggleChatPinnedById(ctx.params.id);
        if (!updated) err(401, DEFAULT_ERROR());
        return ctx.json(chatResponse(updated));
      }
      err(401, DEFAULT_ERROR());
    },
  },

  // POST /{id}/fork — fork a chat branch
  {
    method: 'POST',
    path: ':id/fork',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await requireChatImportPermission(user);
      const id = ctx.params.id;

      let chat: ChatModel | null = await getAccessibleChatById(id, user);
      if (!chat) {
        chat = chatFromResponseData(await getSharedChatHandlerData(id, user));
      }

      const isSnapshot = chat.id === chat.share_id;
      const isOwner = chat.user_id === user.id;

      const history = chat.chat?.history ?? {};
      let messagesMap: Record<string, any> = history.messages ?? {};
      if (!isSnapshot) {
        messagesMap = (await getMessagesMapByChatId(chat.id)) ?? messagesMap;
      }

      const form = await ctx.body<{ message_id?: string | null }>().catch(() => ({}) as { message_id?: string | null });
      const sourceMessageId =
        form?.message_id || chat.current_message_id || history.currentId || null;
      if (!sourceMessageId) err(400, 'chat has no messages to fork');

      const [forkHistory, forkMessages] = buildForkHistory(messagesMap, sourceMessageId);

      for (const message of Object.values(forkHistory.messages)) {
        if (!isObj(message)) continue;
        const author = isObj(history.messages?.[message.id]) ? history.messages[message.id].user : null;
        if (isObj(author) && author.id === message.user_id) {
          message.user = author;
        }
        if (message.role !== 'assistant' || message.done !== false) continue;

        // An unfinished message is stale unless it is awaiting tool approval
        const output = Array.isArray(message.output) ? message.output : [];
        if (
          output.some(
            (item) =>
              isObj(item) &&
              item.type === 'function_call' &&
              ['pending', 'queued', 'requires_approval'].includes(String(item.status))
          )
        ) {
          continue;
        }
        message.done = true;
      }

      let updatedChat: Record<string, any> = { ...(chat.chat ?? {}) };
      delete updatedChat.currentId;
      delete updatedChat.share_mode;
      updatedChat = {
        ...updatedChat,
        originalChatId: chat.id,
        branchPointMessageId: sourceMessageId,
        title: `${chat.title} (fork)`,
        history: forkHistory,
        messages: forkMessages,
      };
      if (!isOwner) {
        const ownerView = await sharedChatResponse({ ...chat, chat: updatedChat }, user);
        updatedChat = ownerView.chat;
        const messages = [
          ...Object.values(updatedChat.history?.messages ?? {}),
          ...(Array.isArray(updatedChat.messages) ? updatedChat.messages : []),
        ];
        for (const message of messages) {
          if (!isObj(message)) continue;
          if ((message.user_id ?? chat.user_id) === chat.user_id) {
            message.user_id = user.id;
            if (message.role === 'user') message.user = { id: user.id, name: user.name };
          }
        }
      }
      const meta: Record<string, any> = {
        ...(isOwner ? (chat.meta ?? {}) : {}),
        forked_from: chat.id,
        forked_from_message_id: sourceMessageId,
      };

      // The source chat's folder may no longer be writable by the caller.
      let folderId = isOwner ? chat.folder_id : null;
      if (folderId !== null && folderId !== undefined && !(await hasFolderWriteAccess(user.id, folderId))) {
        folderId = null;
      }

      let fork = await insertNewChat(crypto.randomUUID(), user.id, { chat: updatedChat, folder_id: folderId }, {
        internalMeta: meta,
      });

      if (fork && isOwner && chat.variables && Object.keys(chat.variables).length) {
        fork = (await updateChatVariablesById(fork.id, chat.variables, false)) ?? fork;
      }

      if (!fork) err(500, DEFAULT_ERROR());

      if (isOwner && chat.pinned) {
        fork = (await toggleChatPinnedById(fork.id)) ?? fork;
      }

      return ctx.json(chatResponse(fork));
    },
  },

  // POST /{id}/clone — clone a chat
  {
    method: 'POST',
    path: ':id/clone',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await requireChatImportPermission(user);
      const id = ctx.params.id;

      const chat = await getChatByIdAndUserId(id, user.id);
      if (chat) {
        const form = await ctx.body<{ title?: string | null }>();
        const updatedChat: Record<string, any> = {
          ...(chat.chat ?? {}),
          originalChatId: chat.id,
          branchPointMessageId: chat.chat?.history?.currentId ?? null,
          title: form.title ? form.title : `Clone of ${chat.title}`,
        };

        const chats = await importChats(user.id, [
          {
            chat: updatedChat,
            meta: chat.meta ?? {},
            variables: chat.variables ?? {},
            pinned: chat.pinned ?? false,
            folder_id: chat.folder_id ?? null,
          },
        ]);

        if (chats.length) {
          return ctx.json(chatResponse(chats[0]));
        }
        err(500, DEFAULT_ERROR());
      }
      err(401, DEFAULT_ERROR());
    },
  },

  // POST /{id}/clone/shared — clone a shared chat
  {
    method: 'POST',
    path: ':id/clone/shared',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await requireChatImportPermission(user);
      const id = ctx.params.id;

      // Enforce access grants (owner and admins bypass)
      const shared = await getSharedChatById(id);
      if (shared && !(user.role === 'admin' && ENABLE_ADMIN_CHAT_ACCESS) && shared.user_id !== user.id) {
        const hasGrant =
          (await isOpenSharedChat(shared)) ||
          (await canReadSharedChat(user, shared));
        if (!hasGrant) err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      let chat: ChatModel | null = shared ? await getChatByShareId(id) : null;
      if (shared && shared.chat.share_mode === 'continue' && (await canReadSharedChat(user, shared))) {
        chat = await getChatById(shared.chat_id);
      }

      // Fallback: admins can also access any chat directly by chat ID
      if (!chat && user.role === 'admin' && ENABLE_ADMIN_CHAT_ACCESS) {
        chat = await getChatById(id);
      }

      if (!chat) err(401, ERROR_MESSAGES.NOT_FOUND);

      const sharedData = await sharedChatResponse(chat, user);
      const updatedChat: Record<string, any> = {
        ...sharedData.chat,
        originalChatId: chat.id,
        branchPointMessageId: chat.chat?.history?.currentId ?? null,
        title: `Clone of ${chat.title}`,
      };
      const messages = [
        ...Object.values(updatedChat.history?.messages ?? {}),
        ...(Array.isArray(updatedChat.messages) ? updatedChat.messages : []),
      ];
      for (const message of messages) {
        if (!isObj(message)) continue;
        if ((message.user_id ?? chat.user_id) === chat.user_id) {
          message.user_id = user.id;
          if (message.role === 'user') message.user = { id: user.id, name: user.name };
        }
      }

      const chats = await importChats(user.id, [
        {
          chat: updatedChat,
          meta: chat.meta ?? {},
          variables: {},
          pinned: chat.pinned ?? false,
          folder_id: null,
        },
      ]);

      if (chats.length) {
        return ctx.json(chatResponse(chats[0]));
      }
      err(500, DEFAULT_ERROR());
    },
  },

  // POST /{id}/archive — toggle archive
  {
    method: 'POST',
    path: ':id/archive',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const chat = await getChatByIdAndUserId(ctx.params.id, user.id);
      if (chat) {
        const updated = await toggleChatArchiveById(ctx.params.id);
        if (!updated) err(401, DEFAULT_ERROR());

        const tagIds = updated.meta?.tags ?? [];
        if (updated.archived) {
          // in-flight task cancellation is a no-op without the task runtime
        } else {
          await ensureTagsExist(tagIds, user.id);
        }
        return ctx.json(chatResponse(updated));
      }
      err(401, DEFAULT_ERROR());
    },
  },

  // POST /{id}/share — share a chat
  {
    method: 'POST',
    path: ':id/share',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;

      if (user.role !== 'admin') {
        const permissions = await userPermissionsConfig();
        if (!(await hasPermission(user.id, 'chat.share', permissions))) {
          err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
        }
      }

      const chat = await getChatByIdAndUserId(id, user.id);
      if (!chat) err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);

      const form = await ctx.body<{ share_mode?: string | null }>().catch(() => ({}) as { share_mode?: string | null });

      // If a share already exists, re-snapshot it
      if (chat.share_id) {
        const shared = await updateSharedChat(chat.share_id, {
          share_mode: form?.share_mode ?? undefined,
        });
        if (shared) {
          const refreshed = await getChatById(id);
          if (refreshed) return ctx.json(chatResponse(refreshed));
        }
      }

      // Create a new share
      const shared = await createSharedChat(id, user.id, form?.share_mode ?? null);
      if (!shared) err(500, DEFAULT_ERROR());

      const updated = await updateChatShareIdById(id, shared.id);
      if (!updated) err(500, DEFAULT_ERROR());
      return ctx.json(chatResponse(updated));
    },
  },

  // DELETE /{id}/share — delete the shared chat
  {
    method: 'DELETE',
    path: ':id/share',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;

      const chat = await getChatByIdAndUserId(id, user.id);
      if (!chat) err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);

      await deleteSharedChatByChatId(id);

      if (chat.share_id) {
        await updateChatShareIdById(id, null);
      }

      await setAccessGrants('shared_chat', id, []);
      return ctx.json(true);
    },
  },

  // POST /{id}/unread — mark a chat unread
  {
    method: 'POST',
    path: ':id/unread',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;

      const chat = await markChatUnreadById(id, user.id);
      if (!chat) err(404, ERROR_MESSAGES.NOT_FOUND);

      const folderId = await getChatFolderId(id, user.id);
      return ctx.json({
        chat_id: id,
        last_read_at: chat.last_read_at,
        folder_id: folderId,
        folder_unread_counts: await getFolderUnreadCounts(user.id),
      });
    },
  },

  // POST /{id}/folder — move a chat to a folder
  {
    method: 'POST',
    path: ':id/folder',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const form = await ctx.body<{ folder_id?: string | null }>();
      const folderId = form.folder_id ?? null;

      const chat = await getChatById(id);
      if (chat && chat.user_id !== user.id) {
        if (!(await hasChatMoveAccess(user.id, chat.folder_id ?? null, folderId))) {
          err(401, DEFAULT_ERROR());
        }
      }
      if (chat) {
        // None is allowed: it moves the chat out of any folder.
        if (folderId !== null && !(await hasFolderWriteAccess(user.id, folderId))) {
          err(404, ERROR_MESSAGES.NOT_FOUND);
        }

        const updated = await updateChatFolderIdByIdAndUserId(id, user.id, folderId);
        if (!updated) err(500, DEFAULT_ERROR());

        if (updated.user_id !== user.id) {
          return ctx.json(await sharedChatResponse(updated, user));
        }
        return ctx.json(chatResponse(updated));
      }
      err(401, DEFAULT_ERROR());
    },
  },

  // GET /{id}/tags — chat tags
  {
    method: 'GET',
    path: ':id/tags',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const chat = await getAccessibleChatById(ctx.params.id, user);
      if (chat) {
        const tags = chat.meta?.tags ?? [];
        return ctx.json(await getTagsByIdsAndUserId(tags, chat.user_id));
      }
      err(401, ERROR_MESSAGES.NOT_FOUND);
    },
  },

  // POST /{id}/tags — add a tag
  {
    method: 'POST',
    path: ':id/tags',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;

      const chat = await getChatByIdAndUserId(id, user.id);
      if (chat) {
        const form = await ctx.body<{ name?: string }>();
        const name = typeof form.name === 'string' ? form.name : '';
        const tags = chat.meta?.tags ?? [];
        const tagId = name.replace(/ /g, '_').toLowerCase();

        if (tagId === 'none') {
          err(400, DEFAULT_ERROR("Tag name cannot be 'None'"));
        }

        if (!tags.includes(tagId)) {
          await addChatTagByIdAndUserIdAndTagName(id, user.id, name);
        }

        const refreshed = await getChatByIdAndUserId(id, user.id);
        const refreshedTags = refreshed?.meta?.tags ?? [];
        return ctx.json(await getTagsByIdsAndUserId(refreshedTags, user.id));
      }
      err(401, DEFAULT_ERROR());
    },
  },

  // DELETE /{id}/tags — delete a tag
  {
    method: 'DELETE',
    path: ':id/tags',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;

      const chat = await getChatByIdAndUserId(id, user.id);
      if (chat) {
        const form = await ctx.body<{ name?: string }>();
        const name = typeof form.name === 'string' ? form.name : '';

        await deleteTagByIdAndUserIdAndTagName(id, user.id, name);

        if ((await countChatsByTagNameAndUserId(name, user.id)) === 0) {
          await deleteTagByNameAndUserId(name, user.id);
        }

        const refreshed = await getChatByIdAndUserId(id, user.id);
        const refreshedTags = refreshed?.meta?.tags ?? [];
        return ctx.json(await getTagsByIdsAndUserId(refreshedTags, user.id));
      }
      err(401, ERROR_MESSAGES.NOT_FOUND);
    },
  },
];
