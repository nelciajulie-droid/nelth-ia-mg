import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import crypto from 'crypto';
import fs from 'fs';
import { db, queryUnsafe, IS_SQLITE } from '@/lib/db';
import { configGet, configSet } from '@/lib/config';
import { env, ERROR_MESSAGES } from '@/lib/constants';
import { createApiKey, getPasswordHash } from '@/lib/auth';
import { getPermissions, hasPermission } from '@/lib/access-control';
import { Auths } from '@/lib/models/auths';
import {
  Users,
  UserModel,
  userModelDump,
  getGroupsByMemberId,
  getGroupsByMemberIds,
  validateImageUrl,
} from '@/lib/models/users';
import { getAccessibleResourceIds, getTools } from '@/lib/models/workspace';

/**
 * Port of open_webui/routers/users.py (v0.12.5) — /api/v1/users/*.
 *
 * Deviations:
 *  • publish_event / socket disconnects are no-ops (no event bus runtime).
 *  • The static fallback avatar for /{id}/profile/image is read from
 *    `public/user.png`; when the asset is absent an inline 1×1 PNG is served
 *    (Python serves open_webui/static/user.png).
 */

// ---------------------------------------------------------------------------
// Env mirrors (Python env.py / config.py defaults)
// ---------------------------------------------------------------------------

const envBool = (key: string, def: string) => (process.env[key] ?? def).toLowerCase() === 'true';

const ENABLE_PROFILE_IMAGE_URL_FORWARDING = envBool('ENABLE_PROFILE_IMAGE_URL_FORWARDING', 'True');
const ENABLE_USER_STATUS = envBool('ENABLE_USER_STATUS', 'True');

const PROFILE_IMAGE_ALLOWED_MIME_TYPES = (
  process.env.PROFILE_IMAGE_ALLOWED_MIME_TYPES || 'image/png,image/jpeg,image/gif,image/webp'
)
  .split(',')
  .map((t) => t.trim().toLowerCase())
  .filter(Boolean);

// Error strings missing from lib/constants.ts (Python v0.12.5 constants.py)
const DELETE_USER_ERROR =
  'Oops! Something went wrong. We encountered an issue while trying to delete the user. Please give it another shot.';
const API_KEY_CREATION_NOT_ALLOWED = 'API key creation is not allowed in the environment.';

const PAGE_ITEM_COUNT = 30;

// ---------------------------------------------------------------------------
// Python config.py DEFAULT_USER_PERMISSIONS (full v0.12.5 shape)
// ---------------------------------------------------------------------------

const PYTHON_USER_PERMISSIONS: Record<string, Record<string, boolean>> = {
  workspace: {
    models: envBool('USER_PERMISSIONS_WORKSPACE_MODELS_ACCESS', 'True'),
    knowledge: envBool('USER_PERMISSIONS_WORKSPACE_KNOWLEDGE_ACCESS', 'True'),
    prompts: envBool('USER_PERMISSIONS_WORKSPACE_PROMPTS_ACCESS', 'True'),
    tools: envBool('USER_PERMISSIONS_WORKSPACE_TOOLS_ACCESS', 'True'),
    skills: envBool('USER_PERMISSIONS_WORKSPACE_SKILLS_ACCESS', 'True'),
    models_import: envBool('USER_PERMISSIONS_WORKSPACE_MODELS_IMPORT', 'True'),
    models_export: envBool('USER_PERMISSIONS_WORKSPACE_MODELS_EXPORT', 'True'),
    models_hidden: envBool('USER_PERMISSIONS_WORKSPACE_MODELS_HIDDEN', 'True'),
    prompts_import: envBool('USER_PERMISSIONS_WORKSPACE_PROMPTS_IMPORT', 'True'),
    prompts_export: envBool('USER_PERMISSIONS_WORKSPACE_PROMPTS_EXPORT', 'True'),
    tools_import: envBool('USER_PERMISSIONS_WORKSPACE_TOOLS_IMPORT', 'True'),
    tools_export: envBool('USER_PERMISSIONS_WORKSPACE_TOOLS_EXPORT', 'True'),
    skills_import: envBool('USER_PERMISSIONS_WORKSPACE_SKILLS_IMPORT', 'True'),
    skills_export: envBool('USER_PERMISSIONS_WORKSPACE_SKILLS_EXPORT', 'True'),
  },
  sharing: {
    models: envBool('USER_PERMISSIONS_WORKSPACE_MODELS_ALLOW_SHARING', 'True'),
    public_models: envBool('USER_PERMISSIONS_WORKSPACE_MODELS_ALLOW_PUBLIC_SHARING', 'True'),
    knowledge: envBool('USER_PERMISSIONS_WORKSPACE_KNOWLEDGE_ALLOW_SHARING', 'True'),
    public_knowledge: envBool('USER_PERMISSIONS_WORKSPACE_KNOWLEDGE_ALLOW_PUBLIC_SHARING', 'True'),
    prompts: envBool('USER_PERMISSIONS_WORKSPACE_PROMPTS_ALLOW_SHARING', 'True'),
    public_prompts: envBool('USER_PERMISSIONS_WORKSPACE_PROMPTS_ALLOW_PUBLIC_SHARING', 'True'),
    tools: envBool('USER_PERMISSIONS_WORKSPACE_TOOLS_ALLOW_SHARING', 'True'),
    public_tools: envBool('USER_PERMISSIONS_WORKSPACE_TOOLS_ALLOW_PUBLIC_SHARING', 'True'),
    skills: envBool('USER_PERMISSIONS_WORKSPACE_SKILLS_ALLOW_SHARING', 'True'),
    public_skills: envBool('USER_PERMISSIONS_WORKSPACE_SKILLS_ALLOW_PUBLIC_SHARING', 'True'),
    notes: envBool('USER_PERMISSIONS_NOTES_ALLOW_SHARING', 'True'),
    public_notes: envBool('USER_PERMISSIONS_NOTES_ALLOW_PUBLIC_SHARING', 'True'),
    folders: envBool('USER_PERMISSIONS_FOLDERS_ALLOW_SHARING', 'True'),
    public_chats: envBool('USER_PERMISSIONS_CHAT_ALLOW_PUBLIC_SHARING', 'True'),
    open_chats: envBool('USER_PERMISSIONS_CHAT_ALLOW_OPEN_SHARING', 'True'),
    public_calendars: envBool('USER_PERMISSIONS_CALENDAR_ALLOW_PUBLIC_SHARING', 'True'),
  },
  access_grants: {
    allow_users: envBool('USER_PERMISSIONS_ACCESS_GRANTS_ALLOW_USERS', 'True'),
    allow_groups: envBool('USER_PERMISSIONS_ACCESS_GRANTS_ALLOW_GROUPS', 'True'),
  },
  chat: {
    controls: envBool('USER_PERMISSIONS_CHAT_CONTROLS', 'True'),
    valves: envBool('USER_PERMISSIONS_CHAT_VALVES', 'True'),
    system_prompt: envBool('USER_PERMISSIONS_CHAT_SYSTEM_PROMPT', 'True'),
    params: envBool('USER_PERMISSIONS_CHAT_PARAMS', 'True'),
    file_upload: envBool('USER_PERMISSIONS_CHAT_FILE_UPLOAD', 'True'),
    web_upload: envBool('USER_PERMISSIONS_CHAT_WEB_UPLOAD', 'True'),
    delete: envBool('USER_PERMISSIONS_CHAT_DELETE', 'True'),
    delete_message: envBool('USER_PERMISSIONS_CHAT_DELETE_MESSAGE', 'True'),
    continue_response: envBool('USER_PERMISSIONS_CHAT_CONTINUE_RESPONSE', 'True'),
    regenerate_response: envBool('USER_PERMISSIONS_CHAT_REGENERATE_RESPONSE', 'True'),
    rate_response: envBool('USER_PERMISSIONS_CHAT_RATE_RESPONSE', 'True'),
    edit: envBool('USER_PERMISSIONS_CHAT_EDIT', 'True'),
    share: envBool('USER_PERMISSIONS_CHAT_SHARE', 'True'),
    export: envBool('USER_PERMISSIONS_CHAT_EXPORT', 'True'),
    import: envBool('USER_PERMISSIONS_CHAT_IMPORT', 'True'),
    stt: envBool('USER_PERMISSIONS_CHAT_STT', 'True'),
    tts: envBool('USER_PERMISSIONS_CHAT_TTS', 'True'),
    call: envBool('USER_PERMISSIONS_CHAT_CALL', 'True'),
    multiple_models: envBool('USER_PERMISSIONS_CHAT_MULTIPLE_MODELS', 'True'),
    temporary: envBool('USER_PERMISSIONS_CHAT_TEMPORARY', 'True'),
    temporary_enforced: envBool('USER_PERMISSIONS_CHAT_TEMPORARY_ENFORCED', 'False'),
  },
  features: {
    api_keys: envBool('USER_PERMISSIONS_FEATURES_API_KEYS', 'True'),
    notes: envBool('USER_PERMISSIONS_FEATURES_NOTES', 'True'),
    folders: envBool('USER_PERMISSIONS_FEATURES_FOLDERS', 'True'),
    channels: envBool('USER_PERMISSIONS_FEATURES_CHANNELS', 'True'),
    encrypted_channels: envBool('USER_PERMISSIONS_FEATURES_ENCRYPTED_CHANNELS', 'False'),
    direct_tool_servers: envBool('USER_PERMISSIONS_FEATURES_DIRECT_TOOL_SERVERS', 'True'),
    web_search: envBool('USER_PERMISSIONS_FEATURES_WEB_SEARCH', 'True'),
    image_generation: envBool('USER_PERMISSIONS_FEATURES_IMAGE_GENERATION', 'True'),
    code_interpreter: envBool('USER_PERMISSIONS_FEATURES_CODE_INTERPRETER', 'True'),
    memories: envBool('USER_PERMISSIONS_FEATURES_MEMORIES', 'True'),
    automations: envBool('USER_PERMISSIONS_FEATURES_AUTOMATIONS', 'True'),
    calendar: envBool('USER_PERMISSIONS_FEATURES_CALENDAR', 'True'),
    webhooks: envBool('USER_PERMISSIONS_FEATURES_USER_WEBHOOKS', 'True'),
  },
  settings: {
    interface: envBool('USER_PERMISSIONS_SETTINGS_INTERFACE', 'True'),
  },
};

/** Resolves the persisted `user.permissions` config with Python defaults. */
async function userPermissions(): Promise<Record<string, Record<string, boolean>>> {
  const persisted = await configGet<Record<string, any> | null>('user.permissions', null);
  if (!persisted || typeof persisted !== 'object') return PYTHON_USER_PERMISSIONS;
  const merged: Record<string, Record<string, boolean>> = {};
  for (const [section, defaults] of Object.entries(PYTHON_USER_PERMISSIONS)) {
    const provided = persisted[section];
    merged[section] = { ...defaults };
    if (provided && typeof provided === 'object') {
      for (const [key, value] of Object.entries(provided)) {
        if (key in defaults) merged[section][key] = Boolean(value);
      }
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const nowSec = () => Math.floor(Date.now() / 1000);

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

function queryBool(value: string | null): boolean {
  return value !== null && /^(true|1|yes|on)$/i.test(value);
}

function queryInt(ctx: Ctx, name: string, fallback: number): number {
  const raw = ctx.query.get(name);
  if (raw === null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Python: merge_user_ui_settings — recursive default-merge skipping nulls. */
function mergeUserUiSettings(defaults: Record<string, any>, settings: Record<string, any>): Record<string, any> {
  const merged: Record<string, any> = { ...defaults };
  for (const [key, value] of Object.entries(settings ?? {})) {
    if (value === null) continue;
    const defaultValue = merged[key];
    merged[key] =
      defaultValue != null && typeof defaultValue === 'object' && !Array.isArray(defaultValue) &&
      value != null && typeof value === 'object' && !Array.isArray(value)
        ? mergeUserUiSettings(defaultValue, value)
        : value;
  }
  return merged;
}

/** UserSettings model_dump parity — `ui` defaults to {} when absent. */
function normalizeUserSettings(settings: Record<string, any> | null): Record<string, any> | null {
  if (settings === null || settings === undefined) return null;
  if (typeof settings !== 'object' || Array.isArray(settings)) return null;
  const ui = settings.ui;
  return { ...settings, ui: ui != null && typeof ui === 'object' && !Array.isArray(ui) ? ui : {} };
}

/** UserModel dump for responses (variables excluded, settings normalized). */
function userDump(user: UserModel): Record<string, unknown> {
  const dump = userModelDump(user);
  (dump as any).settings = normalizeUserSettings(user.settings as any);
  return dump;
}

// ---------------------------------------------------------------------------
// InterfaceSettings.model_fields (models/users.py) — keys owned by the
// Interface settings panel; unauthorized users cannot change them.
// ---------------------------------------------------------------------------

const INTERFACE_SETTINGS_FIELDS = [
  'autoTags',
  'autoFollowUps',
  'highContrastMode',
  'detectArtifacts',
  'responseAutoCopy',
  'showUsername',
  'showUpdateToast',
  'showChangelog',
  'showEmojiInCall',
  'voiceInterruption',
  'displayMultiModelResponsesInTabs',
  'chatFadeStreamingText',
  'richTextInput',
  'showFormattingToolbar',
  'insertPromptAsRichText',
  'promptAutocomplete',
  'insertSuggestionPrompt',
  'keepFollowUpPrompts',
  'insertFollowUpPrompt',
  'regenerateMenu',
  'enableMessageQueue',
  'largeTextAsFile',
  'copyFormatted',
  'collapseCodeBlocks',
  'renderMarkdownInUserMessages',
  'renderMarkdownInAssistantMessages',
  'expandDetails',
  'chatHoverPreview',
  'renderMarkdownInPreviews',
  'chatBubble',
  'widescreenMode',
  'splitLargeChunks',
  'scrollOnBranchChange',
  'scrollOnResponseGeneration',
  'showFilesOnTerminalSelect',
  'temporaryChatByDefault',
  'userLocation',
  'showChatTitleInTab',
  'iframeSandboxAllowScripts',
  'iframeSandboxAllowSameOrigin',
  'iframeSandboxAllowForms',
  'iframeSandboxAllowDownloads',
  'terminalPreviewAllowSameOrigin',
  'stylizedPdfExport',
  'hapticFeedback',
  'ctrlEnterToSend',
  'showFloatingActionButtons',
  'imageCompression',
  'imageCompressionInChannels',
  'landingPageMode',
  'chatDirection',
  'terminalFileDisplay',
  'defaultUploadContext',
  'webSearch',
  'models',
  'backgroundImageUrl',
  'fontFamily',
  'textScale',
  'title',
  'imageCompressionSize',
  'floatingActionButtons',
];

// ---------------------------------------------------------------------------
// User variables (utils/chat_variables.py)
// ---------------------------------------------------------------------------

const CHAT_VARIABLE_KEY_RE = /^[a-z][a-z0-9_]*$/;
const MAX_VARIABLE_VALUE_LENGTH = 20_000;
const MAX_VARIABLES_JSON_LENGTH = 100_000;

function normalizeUserVariables(variables: any): Record<string, string> {
  if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function validateUserVariables(variables: any): Record<string, string> {
  if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) {
    throw new HttpError(400, 'User variables must be an object.');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(variables);
  } catch {
    throw new HttpError(400, 'User variables must be JSON serializable.');
  }
  if (serialized.length > MAX_VARIABLES_JSON_LENGTH) {
    throw new HttpError(400, 'User variables are too large.');
  }
  const validated: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (typeof key !== 'string' || !CHAT_VARIABLE_KEY_RE.test(key)) {
      throw new HttpError(400, `Invalid user variable key: ${key}`);
    }
    if (typeof value !== 'string') {
      throw new HttpError(400, `User variable must be a string: ${key}`);
    }
    const normalized = value.replace(/\r\n/g, '\n');
    if (normalized.length > MAX_VARIABLE_VALUE_LENGTH) {
      throw new HttpError(400, `User variable is too long: ${key}`);
    }
    validated[key] = normalized;
  }
  return validated;
}

// ---------------------------------------------------------------------------
// Usage stats (models/chat_messages.py + models/chats.py) — raw SQL parity
// ---------------------------------------------------------------------------

function normalizeTimestamp(timestamp: number | null | undefined): number {
  const now = nowSec();
  if (timestamp === null || timestamp === undefined) return now;
  let v = Number(timestamp);
  if (!Number.isFinite(v)) return now;
  if (v > 10_000_000_000) v = v / 1000;
  const minValid = 1577836800;
  const maxValid = now + 86400;
  if (v < minValid || v > maxValid) return now;
  return v;
}

function dateKey(timestamp: number, tz: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(normalizeTimestamp(timestamp) * 1000));
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(normalizeTimestamp(timestamp) * 1000));
  }
}

// usage JSON token access — Postgres jsonb / SQLite json_extract.
const TOKEN_INPUT_SQL = IS_SQLITE
  ? `COALESCE(CAST(CASE WHEN chat_message.usage IS NOT NULL AND json_valid(chat_message.usage) THEN json_extract(chat_message.usage, '$.input_tokens') END AS INTEGER), CAST(CASE WHEN chat_message.usage IS NOT NULL AND json_valid(chat_message.usage) THEN json_extract(chat_message.usage, '$.prompt_tokens') END AS INTEGER))`
  : `COALESCE(CAST(NULLIF(chat_message.usage, '')::jsonb ->> 'input_tokens' AS INTEGER), CAST(NULLIF(chat_message.usage, '')::jsonb ->> 'prompt_tokens' AS INTEGER))`;
const TOKEN_OUTPUT_SQL = IS_SQLITE
  ? `COALESCE(CAST(CASE WHEN chat_message.usage IS NOT NULL AND json_valid(chat_message.usage) THEN json_extract(chat_message.usage, '$.output_tokens') END AS INTEGER), CAST(CASE WHEN chat_message.usage IS NOT NULL AND json_valid(chat_message.usage) THEN json_extract(chat_message.usage, '$.completion_tokens') END AS INTEGER))`
  : `COALESCE(CAST(NULLIF(chat_message.usage, '')::jsonb ->> 'output_tokens' AS INTEGER), CAST(NULLIF(chat_message.usage, '')::jsonb ->> 'completion_tokens' AS INTEGER))`;

// chat.meta internal filter for usage stats.
const INTERNAL_CHAT_FILTER = IS_SQLITE
  ? `chat.user_id = $1 AND CAST(COALESCE(CASE WHEN chat.meta IS NOT NULL AND json_valid(chat.meta) THEN json_extract(chat.meta, '$.internal') END, '') AS TEXT) NOT IN ('1', 'true', 'True')`
  : `chat.user_id = $1 AND COALESCE(NULLIF(chat.meta, '')::jsonb ->> 'internal', '') NOT IN ('1', 'true', 'True')`;

async function getUserUsageSummary(
  userId: string,
  startDate?: number | null,
  endDate?: number | null,
  includeActiveDays = true,
  timezone: string | null = null
): Promise<Record<string, number>> {
  const dateConds: string[] = [];
  const dateArgs: any[] = [];
  if (startDate) {
    dateConds.push('chat_message.created_at >= $2');
    dateArgs.push(startDate);
  }
  if (endDate) {
    dateConds.push('chat_message.created_at <= $3');
    dateArgs.push(endDate);
  }
  const dateSql = dateConds.length ? ` AND ${dateConds.join(' AND ')}` : '';

  const messageRows = await queryUnsafe<Array<{ role: string; count: number | bigint }>>(
    `SELECT chat_message.role, COUNT(chat_message.id) AS count FROM chat_message WHERE chat_message.user_id = $1${dateSql} GROUP BY chat_message.role`,
    userId,
    ...dateArgs
  );
  const messageCounts: Record<string, number> = {};
  for (const row of messageRows) messageCounts[row.role] = Number(row.count);

  const tokenRows = await queryUnsafe<Array<{ input_tokens: number | bigint; output_tokens: number | bigint }>>(
    `SELECT COALESCE(SUM(${TOKEN_INPUT_SQL}), 0) AS input_tokens, COALESCE(SUM(${TOKEN_OUTPUT_SQL}), 0) AS output_tokens FROM chat_message WHERE chat_message.user_id = $1 AND chat_message.role = 'assistant' AND chat_message.usage IS NOT NULL${dateSql}`,
    userId,
    ...dateArgs
  );
  const inputTotal = Number(tokenRows[0]?.input_tokens ?? 0);
  const outputTotal = Number(tokenRows[0]?.output_tokens ?? 0);

  const modelRows = await queryUnsafe<Array<{ models_used: number | bigint }>>(
    `SELECT COUNT(DISTINCT chat_message.model_id) AS models_used FROM chat_message WHERE chat_message.user_id = $1 AND chat_message.role = 'assistant' AND chat_message.model_id IS NOT NULL${dateSql}`,
    userId,
    ...dateArgs
  );

  let activeDays = 0;
  if (includeActiveDays) {
    const dayRows = await queryUnsafe<Array<{ created_at: number }>>(
      `SELECT chat_message.created_at FROM chat_message WHERE chat_message.user_id = $1${dateSql} AND chat_message.created_at > 0`,
      userId,
      ...dateArgs
    );
    activeDays = new Set(dayRows.map((r) => dateKey(Number(r.created_at), timezone))).size;
  }

  return {
    messages: Object.values(messageCounts).reduce((a, b) => a + b, 0),
    user_messages: messageCounts['user'] ?? 0,
    assistant_messages: messageCounts['assistant'] ?? 0,
    input_tokens: inputTotal,
    output_tokens: outputTotal,
    total_tokens: inputTotal + outputTotal,
    models_used: Number(modelRows[0]?.models_used ?? 0),
    active_days: activeDays,
  };
}

async function getUserDailyUsage(
  userId: string,
  startDate: number,
  endDate: number,
  timezone: string | null
): Promise<Record<string, any>[]> {
  const rows = await queryUnsafe<
    Array<{
      created_at: number;
      chat_id: string;
      role: string;
      model_id: string | null;
      usage: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
    }>
  >(
    `SELECT chat_message.created_at, chat_message.chat_id, chat_message.role, chat_message.model_id, chat_message.usage, ${TOKEN_INPUT_SQL} AS input_tokens, ${TOKEN_OUTPUT_SQL} AS output_tokens FROM chat_message WHERE chat_message.user_id = $1 AND chat_message.created_at >= $2 AND chat_message.created_at <= $3 AND chat_message.created_at > 0`,
    userId,
    startDate,
    endDate
  );

  const daily: Record<string, Record<string, any>> = {};
  for (const row of rows) {
    const date = dateKey(Number(row.created_at), timezone);
    const entry = (daily[date] ??= { date, messages: 0, chat_ids: new Set<string>(), tokens: 0, models: {} });
    entry.messages += 1;
    (entry.chat_ids as Set<string>).add(row.chat_id);
    if (row.role === 'assistant' && row.model_id) {
      entry.models[row.model_id] = (entry.models[row.model_id] ?? 0) + 1;
    }
    if (row.usage) {
      entry.tokens += Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0);
    }
  }

  // Fill missing days between start and end (in the user's timezone)
  const tz = timezone && isValidTimeZone(timezone) ? timezone : 'UTC';
  const start = new Date(normalizeTimestamp(startDate) * 1000);
  const end = new Date(normalizeTimestamp(endDate) * 1000);
  const startDay = new Date(start.toLocaleString('en-US', { timeZone: tz }));
  const endDay = new Date(end.toLocaleString('en-US', { timeZone: tz }));
  startDay.setHours(0, 0, 0, 0);
  endDay.setHours(0, 0, 0, 0);
  for (let d = new Date(startDay); d <= endDay; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
    daily[key] ??= { date: key, messages: 0, chat_ids: new Set<string>(), tokens: 0, models: {} };
  }

  return Object.values(daily)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((item) => ({
      date: item.date,
      messages: item.messages,
      chats: (item.chat_ids as Set<string>).size,
      tokens: item.tokens,
      models: item.models,
    }));
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function getUserTopModels(userId: string, startDate: number, endDate: number, limit = 5) {
  const rows = await queryUnsafe<
    Array<{ model_id: string; messages: number | bigint; input_tokens: number | bigint; output_tokens: number | bigint }>
  >(
    `SELECT chat_message.model_id, COUNT(chat_message.id) AS messages, COALESCE(SUM(${TOKEN_INPUT_SQL}), 0) AS input_tokens, COALESCE(SUM(${TOKEN_OUTPUT_SQL}), 0) AS output_tokens FROM chat_message WHERE chat_message.user_id = $1 AND chat_message.role = 'assistant' AND chat_message.model_id IS NOT NULL AND chat_message.created_at >= $2 AND chat_message.created_at <= $3 GROUP BY chat_message.model_id ORDER BY COUNT(chat_message.id) DESC LIMIT ${Math.max(0, Math.floor(limit))}`,
    userId,
    startDate,
    endDate
  );
  return rows.map((row) => ({
    model_id: row.model_id,
    messages: Number(row.messages),
    input_tokens: Number(row.input_tokens ?? 0),
    output_tokens: Number(row.output_tokens ?? 0),
    total_tokens: Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0),
  }));
}

async function getUserTopTools(userId: string, startDate: number, endDate: number, limit = 5) {
  const rows = await queryUnsafe<Array<{ output: string | null; meta: string | null }>>(
    `SELECT chat_message.output, chat_message.meta FROM chat_message WHERE chat_message.user_id = $1 AND chat_message.created_at >= $2 AND chat_message.created_at <= $3`,
    userId,
    startDate,
    endDate
  );
  const counts = new Map<string, number>();
  const addNames = (value: any) => {
    const walk = (item: any) => {
      if (Array.isArray(item)) {
        for (const child of item) walk(child);
        return;
      }
      if (item === null || typeof item !== 'object') return;
      const itemType = String(item.type ?? '');
      const looksLikeTool = itemType.includes('tool') || ['function_call', 'function_call_output'].includes(itemType);
      if (looksLikeTool) {
        for (const name of [item.name ?? item.tool_name, typeof item.function === 'object' ? item.function?.name : null]) {
          if (typeof name === 'string') {
            const cleaned = name.trim();
            if (cleaned && cleaned.length <= 128) counts.set(cleaned, (counts.get(cleaned) ?? 0) + 1);
          }
        }
      }
      for (const key of ['tool_calls', 'tools', 'output', 'meta']) {
        if (key in item) walk(item[key]);
      }
    };
    walk(value);
  };
  for (const row of rows) {
    for (const raw of [row.output, row.meta]) {
      if (!raw) continue;
      try {
        addNames(JSON.parse(raw));
      } catch {
        /* skip malformed JSON */
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

const ACTIVE_CHAT_GAP_SECONDS = 30 * 60;

async function getUserUsageChatStats(userId: string): Promise<Record<string, number>> {
  const chatFilter = INTERNAL_CHAT_FILTER;
  const totalRows = await queryUnsafe<Array<{ total_chats: number | bigint }>>(
    `SELECT COUNT(chat.id) AS total_chats FROM chat WHERE ${chatFilter}`,
    userId
  );
  const messageRows = await queryUnsafe<Array<{ chat_id: string; created_at: number }>>(
    `SELECT chat_message.chat_id, chat_message.created_at FROM chat_message JOIN chat ON chat.id = chat_message.chat_id WHERE ${chatFilter} AND chat_message.created_at IS NOT NULL ORDER BY chat_message.chat_id, chat_message.created_at ASC`,
    userId
  );

  const lastMessageAtByChat: Record<string, number> = {};
  const activeSecondsByChat: Record<string, number> = {};
  for (const row of messageRows) {
    const raw = Number(row.created_at);
    const timestamp = raw > 10_000_000_000 ? Math.floor(raw / 1000) : Math.floor(raw);
    const lastMessageAt = lastMessageAtByChat[row.chat_id];
    if (lastMessageAt !== undefined) {
      const delta = timestamp - lastMessageAt;
      if (delta > 0 && delta <= ACTIVE_CHAT_GAP_SECONDS) {
        activeSecondsByChat[row.chat_id] = (activeSecondsByChat[row.chat_id] ?? 0) + delta;
      }
    }
    lastMessageAtByChat[row.chat_id] = timestamp;
  }

  return {
    total_chats: Number(totalRows[0]?.total_chats ?? 0),
    longest_chat_seconds: Math.max(0, ...Object.values(activeSecondsByChat)),
  };
}

// Heatmap helpers (routers/users.py)

function weekStart(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() ? date.getUTCDay() : 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - day);
  return date.toISOString().slice(0, 10);
}

function buildWeeklyHeatmap(heatmap: Record<string, any>[]): Record<string, any>[] {
  const weeks: Record<string, Record<string, any>> = {};
  for (const day of heatmap) {
    const week = weekStart(day.date);
    const entry = (weeks[week] ??= { date: week, messages: 0, chats: 0, tokens: 0, models: {} });
    entry.messages += day.messages ?? 0;
    entry.chats += day.chats ?? 0;
    entry.tokens += day.tokens ?? 0;
    for (const [model, count] of Object.entries(day.models ?? {})) {
      entry.models[model] = (entry.models[model] ?? 0) + Number(count);
    }
  }
  return Object.keys(weeks)
    .sort()
    .map((key) => ({ ...weeks[key] }));
}

function buildCumulativeHeatmap(heatmap: Record<string, any>[]): Record<string, any>[] {
  const totals = { messages: 0, chats: 0, tokens: 0 };
  const models: Record<string, number> = {};
  const cumulative: Record<string, any>[] = [];
  for (const day of heatmap) {
    totals.messages += day.messages ?? 0;
    totals.chats += day.chats ?? 0;
    totals.tokens += day.tokens ?? 0;
    for (const [model, count] of Object.entries(day.models ?? {})) {
      models[model] = (models[model] ?? 0) + Number(count);
    }
    cumulative.push({ date: day.date, ...totals, models: { ...models } });
  }
  return cumulative;
}

function calculateStreaks(heatmap: Record<string, any>[]): Record<string, number> {
  let longest = 0;
  let currentRun = 0;
  for (const day of heatmap) {
    if ((day.messages ?? 0) > 0) {
      currentRun += 1;
      longest = Math.max(longest, currentRun);
    } else {
      currentRun = 0;
    }
  }
  let current = 0;
  for (let i = heatmap.length - 1; i >= 0; i--) {
    if ((heatmap[i].messages ?? 0) <= 0) break;
    current += 1;
  }
  return { current, longest };
}

// ---------------------------------------------------------------------------
// User groups response (shared by /groups and /{user_id}/groups)
// ---------------------------------------------------------------------------

async function userGroupsResponse(userId: string, includeInherited: boolean) {
  const direct = await getGroupsByMemberId(userId, false);
  if (!includeInherited) return direct;
  const directIds = new Set(direct.map((g) => g.id));
  const effective = await getGroupsByMemberId(userId, true);
  return effective.map((g) => ({ ...g, membership_type: directIds.has(g.id) ? 'direct' : 'inherited' }));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // GET / — admin user listing (UserGroupIdsListResponse)
  {
    method: 'GET',
    path: '',
    auth: 'admin',
    handler: async (ctx) => {
      const page = Math.max(1, queryInt(ctx, 'page', 1));
      const skip = (page - 1) * PAGE_ITEM_COUNT;

      const filter: Record<string, any> = {};
      const query = ctx.query.get('query');
      if (query) filter.query = query;

      const result = await Users.getUsers({
        filter,
        sort: { order_by: ctx.query.get('order_by'), direction: ctx.query.get('direction') },
        skip,
        limit: PAGE_ITEM_COUNT,
      });

      const userGroups = await getGroupsByMemberIds(result.users.map((u) => u.id));

      return ctx.json({
        users: result.users.map((user) => ({
          ...userDump(user),
          group_ids: (userGroups.get(user.id) ?? []).map((g) => g.id),
        })),
        total: result.total,
      });
    },
  },

  // GET /all — all users (UserInfoListResponse)
  // PUBLIC-APP MODE: auth 'user' (Python parity — get_verified_user) so the
  // sharing modal can list members for every account, not only admins.
  {
    method: 'GET',
    path: 'all',
    auth: 'user',
    handler: async (ctx) => {
      requireUser(ctx);
      const result = await Users.getUsers();
      return ctx.json({ users: result.users.map((u) => toUserInfoResponse(u)), total: result.total });
    },
  },

  // GET /search — user search (UserInfoListResponse)
  {
    method: 'GET',
    path: 'search',
    auth: 'user',
    handler: async (ctx) => {
      requireUser(ctx);
      const page = Math.max(1, queryInt(ctx, 'page', 1));
      const skip = (page - 1) * PAGE_ITEM_COUNT;
      const filter: Record<string, any> = {};
      const query = ctx.query.get('query');
      if (query) filter.query = query;

      const result = await Users.getUsers({
        filter,
        sort: { order_by: ctx.query.get('order_by'), direction: ctx.query.get('direction') },
        skip,
        limit: PAGE_ITEM_COUNT,
      });
      return ctx.json({ users: result.users.map((u) => toUserInfoResponse(u)), total: result.total });
    },
  },

  // GET /groups — session user's groups
  {
    method: 'GET',
    path: 'groups',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      return ctx.json(await userGroupsResponse(user.id, queryBool(ctx.query.get('include_inherited'))));
    },
  },

  // GET /permissions — session user's effective permissions
  {
    method: 'GET',
    path: 'permissions',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      return ctx.json(await getPermissions(user.id, await userPermissions()));
    },
  },

  // GET /default/permissions — admin view of default permissions
  {
    method: 'GET',
    path: 'default/permissions',
    auth: 'admin',
    handler: async (ctx) => {
      requireAdmin(ctx);
      const persisted = await configGet<Record<string, any> | null>('user.permissions', null);
      return ctx.json(pydanticUserPermissions(persisted ?? {}));
    },
  },

  // POST /default/permissions — update default permissions
  {
    method: 'POST',
    path: 'default/permissions',
    auth: 'admin',
    handler: async (ctx) => {
      requireAdmin(ctx);
      const form = await ctx.body<Record<string, any>>();
      const userPermissions = pydanticUserPermissions(form);
      await configSet('user.permissions', userPermissions);
      return ctx.json(userPermissions);
    },
  },

  // GET /default/permissions/defaults — the built-in defaults
  {
    method: 'GET',
    path: 'default/permissions/defaults',
    auth: 'admin',
    handler: async (ctx) => {
      requireAdmin(ctx);
      return ctx.json(pydanticUserPermissions(PYTHON_USER_PERMISSIONS));
    },
  },

  // GET /user/settings — session user settings (merged with UI defaults)
  {
    method: 'GET',
    path: 'user/settings',
    auth: 'user',
    handler: async (ctx) => {
      const sessionUser = requireUser(ctx);
      const user = await Users.getUserById(sessionUser.id);
      if (!user) err(400, ERROR_MESSAGES.USER_NOT_FOUND);

      if (queryBool(ctx.query.get('raw'))) {
        return ctx.json(user.settings ?? null);
      }

      const defaultInterfaceSettings = await configGet<Record<string, any> | null>(
        'ui.default_interface_settings',
        null
      );
      if (
        defaultInterfaceSettings === null ||
        typeof defaultInterfaceSettings !== 'object' ||
        Array.isArray(defaultInterfaceSettings) ||
        !Object.keys(defaultInterfaceSettings).length
      ) {
        return ctx.json(normalizeUserSettings(user.settings as any));
      }

      const userSettings: Record<string, any> = { ...(user.settings ?? {}) };
      const uiSettings =
        userSettings.ui != null && typeof userSettings.ui === 'object' && !Array.isArray(userSettings.ui)
          ? userSettings.ui
          : {};
      userSettings.ui = mergeUserUiSettings(defaultInterfaceSettings, uiSettings);
      return ctx.json(normalizeUserSettings(userSettings));
    },
  },

  // POST /user/settings/update — update session user settings
  {
    method: 'POST',
    path: 'user/settings/update',
    auth: 'user',
    handler: async (ctx) => {
      const sessionUser = requireUser(ctx);
      const user = await Users.getUserById(sessionUser.id);
      if (!user) err(400, ERROR_MESSAGES.USER_NOT_FOUND);

      // model_dump(exclude_unset=True) — only keys present in the request body
      const updatedUserSettings: Record<string, any> = { ...(await ctx.body<Record<string, any>>()) };
      const uiSettings = updatedUserSettings.ui;
      const permissions = await userPermissions();

      if (uiSettings !== null && typeof uiSettings === 'object' && !Array.isArray(uiSettings)) {
        if (user.role !== 'admin' && !(await hasPermission(user.id, 'settings.interface', permissions))) {
          for (const key of INTERFACE_SETTINGS_FIELDS) delete uiSettings[key];
        }

        if (
          user.role !== 'admin' &&
          'system' in uiSettings &&
          (!(await hasPermission(user.id, 'chat.controls', permissions)) ||
            !(await hasPermission(user.id, 'chat.system_prompt', permissions)))
        ) {
          delete uiSettings.system;
        }
      }

      if (
        user.role !== 'admin' &&
        uiSettings !== null &&
        typeof uiSettings === 'object' &&
        'toolServers' in uiSettings &&
        !(await hasPermission(user.id, 'features.direct_tool_servers', permissions))
      ) {
        delete uiSettings.toolServers;
      }

      const uiNotifications =
        uiSettings !== null && typeof uiSettings === 'object' ? uiSettings.notifications ?? null : null;
      if (
        user.role !== 'admin' &&
        ('notifications' in updatedUserSettings ||
          (uiNotifications !== null && typeof uiNotifications === 'object' && 'webhook_url' in uiNotifications)) &&
        !(await hasPermission(user.id, 'features.webhooks', permissions))
      ) {
        delete updatedUserSettings.notifications;
        if (uiNotifications !== null && typeof uiNotifications === 'object') {
          delete uiNotifications.webhook_url;
        }
      }

      const updated = await Users.updateUserSettingsById(user.id, updatedUserSettings);
      if (!updated) err(400, ERROR_MESSAGES.USER_NOT_FOUND);
      return ctx.json(normalizeUserSettings(updated.settings as any));
    },
  },

  // GET /user/status — session user status
  {
    method: 'GET',
    path: 'user/status',
    auth: 'user',
    handler: async (ctx) => {
      const sessionUser = requireUser(ctx);
      if (!(await configGet<boolean>('users.enable_status', ENABLE_USER_STATUS))) {
        err(403, ERROR_MESSAGES.ACTION_PROHIBITED);
      }
      const user = await Users.getUserById(sessionUser.id);
      if (!user) err(400, ERROR_MESSAGES.USER_NOT_FOUND);
      return ctx.json(userDump(user));
    },
  },

  // POST /user/status/update — update session user status
  {
    method: 'POST',
    path: 'user/status/update',
    auth: 'user',
    handler: async (ctx) => {
      const sessionUser = requireUser(ctx);
      if (!(await configGet<boolean>('users.enable_status', ENABLE_USER_STATUS))) {
        err(403, ERROR_MESSAGES.ACTION_PROHIBITED);
      }
      const user = await Users.getUserById(sessionUser.id);
      if (!user) err(400, ERROR_MESSAGES.USER_NOT_FOUND);

      const form = await ctx.body<{
        status_emoji?: string | null;
        status_message?: string | null;
        status_expires_at?: number | null;
      }>();
      const updated = await Users.updateUserStatusById(user.id, {
        status_emoji: form.status_emoji ?? null,
        status_message: form.status_message ?? null,
        status_expires_at: form.status_expires_at ?? null,
      });
      if (!updated) err(400, ERROR_MESSAGES.USER_NOT_FOUND);
      return ctx.json(userDump(updated));
    },
  },

  // GET /user/info — session user info
  {
    method: 'GET',
    path: 'user/info',
    auth: 'user',
    handler: async (ctx) => {
      const sessionUser = requireUser(ctx);
      const user = await Users.getUserById(sessionUser.id);
      if (!user) err(400, ERROR_MESSAGES.USER_NOT_FOUND);
      return ctx.json(user.info ?? null);
    },
  },

  // GET /user/variables — session user variables (normalized)
  {
    method: 'GET',
    path: 'user/variables',
    auth: 'user',
    handler: async (ctx) => {
      const sessionUser = requireUser(ctx);
      const user = await Users.getUserById(sessionUser.id);
      if (!user) err(400, ERROR_MESSAGES.USER_NOT_FOUND);
      return ctx.json({ variables: normalizeUserVariables(user.variables) });
    },
  },

  // POST /user/variables/update — update session user variables
  {
    method: 'POST',
    path: 'user/variables/update',
    auth: 'user',
    handler: async (ctx) => {
      const sessionUser = requireUser(ctx);
      const user = await Users.getUserById(sessionUser.id);
      if (!user) err(400, ERROR_MESSAGES.USER_NOT_FOUND);

      const form = await ctx.body<{ variables?: Record<string, any> }>();
      const variables = validateUserVariables(form.variables ?? {});

      const updated = await Users.updateUserById(user.id, { variables });
      if (!updated) err(400, ERROR_MESSAGES.USER_NOT_FOUND);
      return ctx.json({ variables });
    },
  },

  // POST /user/info/update — merge session user info
  {
    method: 'POST',
    path: 'user/info/update',
    auth: 'user',
    handler: async (ctx) => {
      const sessionUser = requireUser(ctx);
      const user = await Users.getUserById(sessionUser.id);
      if (!user) err(400, ERROR_MESSAGES.USER_NOT_FOUND);

      const form = await ctx.body<Record<string, any>>();
      const mergedInfo = { ...(user.info ?? {}), ...form };
      const updated = await Users.updateUserById(user.id, { info: mergedInfo });
      if (!updated) err(400, ERROR_MESSAGES.USER_NOT_FOUND);
      return ctx.json(updated.info ?? null);
    },
  },

  // GET /usage — session user usage stats
  {
    method: 'GET',
    path: 'usage',
    auth: 'user',
    handler: async (ctx) => {
      const sessionUser = requireUser(ctx);
      const user = await Users.getUserById(sessionUser.id);
      if (!user) err(400, ERROR_MESSAGES.USER_NOT_FOUND);

      const daysRaw = ctx.query.get('days');
      if (daysRaw !== null && daysRaw !== '') {
        const days = parseInt(daysRaw, 10);
        if (!Number.isFinite(days) || days < 7 || days > 732) {
          err(422, 'Input should be between 7 and 732');
        }
      }
      const startDateRaw = ctx.query.get('start_date');
      const endDateRaw = ctx.query.get('end_date');
      const startDate = startDateRaw !== null && startDateRaw !== '' ? Number(startDateRaw) : null;
      const endDate = endDateRaw !== null && endDateRaw !== '' ? Number(endDateRaw) : null;

      const now = nowSec();
      const periodEnd = endDate ?? now;
      let periodStart: number;
      if (startDate !== null && Number.isFinite(startDate)) {
        periodStart = startDate;
      } else {
        const parsedDays = daysRaw !== null && daysRaw !== '' ? parseInt(daysRaw, 10) : NaN;
        const days = Number.isFinite(parsedDays) ? parsedDays : 730;
        periodStart = periodEnd - (days - 1) * 86400;
      }

      if (periodStart > periodEnd) {
        err(400, 'start_date must be before end_date');
      }

      const periodDays = Math.max(1, Math.floor((periodEnd - periodStart) / 86400) + 1);

      const lifetimeSummary = await getUserUsageSummary(user.id, null, null, false);
      const periodSummary = await getUserUsageSummary(user.id, periodStart, periodEnd, true, user.timezone);
      const chatStats = await getUserUsageChatStats(user.id);
      const heatmap = await getUserDailyUsage(user.id, periodStart, periodEnd, user.timezone);
      const topModels = await getUserTopModels(user.id, periodStart, periodEnd);
      const topTools = await getUserTopTools(user.id, periodStart, periodEnd);

      const streaks = calculateStreaks(heatmap);
      const totalMessages = periodSummary.messages ?? 0;
      const totalChats = chatStats.total_chats ?? 0;
      const activeDays = periodSummary.active_days ?? 0;
      const assistantMessages = periodSummary.assistant_messages ?? 0;
      const userMessages = periodSummary.user_messages ?? 0;

      return ctx.json({
        totals: {
          lifetime_tokens: lifetimeSummary.total_tokens ?? 0,
          input_tokens: lifetimeSummary.input_tokens ?? 0,
          output_tokens: lifetimeSummary.output_tokens ?? 0,
          peak_daily_tokens: Math.max(0, ...heatmap.map((day) => day.tokens ?? 0)),
          longest_chat_seconds: chatStats.longest_chat_seconds ?? 0,
          current_streak: streaks.current,
          longest_streak: streaks.longest,
          total_chats: totalChats,
          active_days: activeDays,
          models_used: lifetimeSummary.models_used ?? 0,
          messages: totalMessages,
          user_messages: userMessages,
          assistant_messages: assistantMessages,
        },
        heatmap,
        weekly_heatmap: buildWeeklyHeatmap(heatmap),
        cumulative_heatmap: buildCumulativeHeatmap(heatmap),
        insights: {
          most_used_model: topModels.length ? topModels[0].model_id : null,
          average_tokens_per_chat: totalChats
            ? Math.round(((lifetimeSummary.total_tokens ?? 0) / totalChats) * 10) / 10
            : 0,
          average_messages_per_active_day: activeDays
            ? Math.round((totalMessages / activeDays) * 10) / 10
            : 0,
          user_message_share: totalMessages ? Math.round((userMessages / totalMessages) * 1000) / 10 : 0,
          assistant_message_share: totalMessages
            ? Math.round((assistantMessages / totalMessages) * 1000) / 10
            : 0,
        },
        top_models: topModels,
        top_tools: topTools,
        period: { start_date: periodStart, end_date: periodEnd, days: periodDays },
      });
    },
  },

  // GET /{user_id} — full user with groups + active flag (admin)
  {
    method: 'GET',
    path: ':user_id',
    auth: 'admin',
    handler: async (ctx) => {
      requireAdmin(ctx);
      const userId = ctx.params.user_id;
      const user = await Users.getUserById(userId);
      if (!user) err(400, ERROR_MESSAGES.USER_NOT_FOUND);

      const groups = await getGroupsByMemberId(userId, false);
      return ctx.json({
        ...userDump(user),
        groups: groups.map((g) => ({ id: g.id, name: g.name })),
        is_active: await Users.isUserActive(userId),
      });
    },
  },

  // GET /{user_id}/info — public-ish user info
  {
    method: 'GET',
    path: ':user_id/info',
    auth: 'user',
    handler: async (ctx) => {
      requireUser(ctx);
      const userId = ctx.params.user_id;
      const user = await Users.getUserById(userId);
      if (!user) err(400, ERROR_MESSAGES.USER_NOT_FOUND);

      const groups = await getGroupsByMemberId(userId, false);
      return ctx.json(
        toUserInfoResponse(
          user,
          groups.map((g) => ({ id: g.id, name: g.name })),
          await Users.isUserActive(userId)
        )
      );
    },
  },

  // GET /{user_id}/oauth/sessions — admin
  {
    method: 'GET',
    path: ':user_id/oauth/sessions',
    auth: 'admin',
    handler: async (ctx) => {
      requireAdmin(ctx);
      const userId = ctx.params.user_id;
      const rows = await db.oAuthSession.findMany({ where: { user_id: userId } });
      const sessions: Record<string, unknown>[] = [];
      for (const row of rows) {
        try {
          const token = JSON.parse(row.token);
          if (token === null || typeof token !== 'object' || Array.isArray(token)) {
            throw new Error('invalid token payload');
          }
          sessions.push({
            id: row.id,
            user_id: row.user_id,
            provider: row.provider,
            token,
            expires_at: row.expires_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
          });
        } catch {
          // Python deletes corrupted (undecryptable) sessions
          await db.oAuthSession.delete({ where: { id: row.id } }).catch(() => undefined);
        }
      }
      if (sessions.length > 0) return ctx.json(sessions);
      err(400, ERROR_MESSAGES.USER_NOT_FOUND);
    },
  },

  // GET /{user_id}/profile/image — serve profile image bytes
  {
    method: 'GET',
    path: ':user_id/profile/image',
    auth: 'user',
    handler: async (ctx) => {
      requireUser(ctx);
      const userId = ctx.params.user_id;
      const user = await Users.getUserById(userId);
      if (!user) err(400, ERROR_MESSAGES.USER_NOT_FOUND);

      const url = user.profile_image_url;
      if (url) {
        if (url.startsWith('http')) {
          if (ENABLE_PROFILE_IMAGE_URL_FORWARDING) {
            return new Response(null, { status: 302, headers: { location: url } });
          }
          // fall through to the default image when forwarding is disabled
        } else if (url.startsWith('data:image')) {
          try {
            const [header, base64Data] = url.split(',', 2);
            const imageData = Buffer.from(base64Data ?? '', 'base64');
            const mediaType = (header.split(';')[0] ?? '').replace(/^data:/, '').toLowerCase();

            if (!PROFILE_IMAGE_ALLOWED_MIME_TYPES.includes(mediaType)) {
              return staticUserPng();
            }
            return new Response(new Uint8Array(imageData), {
              status: 200,
              headers: {
                'content-type': mediaType,
                'content-disposition': 'inline',
                'x-content-type-options': 'nosniff',
              },
            });
          } catch {
            /* fall through to the default image */
          }
        }
      }
      return staticUserPng();
    },
  },

  // GET /{user_id}/active — active flag
  {
    method: 'GET',
    path: ':user_id/active',
    auth: 'user',
    handler: async (ctx) => {
      requireUser(ctx);
      return ctx.json({ active: await Users.isUserActive(ctx.params.user_id) });
    },
  },

  // POST /{user_id}/sessions/revoke — admin
  {
    method: 'POST',
    path: ':user_id/sessions/revoke',
    auth: 'admin',
    handler: async (ctx) => {
      const sessionUser = requireAdmin(ctx);
      const userId = ctx.params.user_id;
      const target = await Users.getUserById(userId);
      if (!target) err(404, 'User not found.');

      const firstUser = await Users.getFirstUser();
      if (firstUser && firstUser.id === userId && sessionUser.id !== userId) {
        err(403, ERROR_MESSAGES.ACTION_PROHIBITED);
      }
      await Auths.revokeSessionsByUserId(userId);
      return ctx.json(true);
    },
  },

  // POST /{user_id}/api_key/rotate — admin
  {
    method: 'POST',
    path: ':user_id/api_key/rotate',
    auth: 'admin',
    handler: async (ctx) => {
      const sessionUser = requireAdmin(ctx);
      const userId = ctx.params.user_id;
      const targetUser = await Users.getUserById(userId);
      if (!targetUser) err(404, ERROR_MESSAGES.USER_NOT_FOUND);

      const firstUser = await Users.getFirstUser();
      if (firstUser && firstUser.id === userId && sessionUser.id !== userId) {
        err(403, ERROR_MESSAGES.ACTION_PROHIBITED);
      }

      const enableApiKeys = await configGet<boolean>('auth.enable_api_keys', env.ENABLE_API_KEY);
      if (
        !enableApiKeys ||
        (targetUser.role !== 'admin' &&
          !(await hasPermission(targetUser.id, 'features.api_keys', await userPermissions())))
      ) {
        err(403, API_KEY_CREATION_NOT_ALLOWED);
      }

      const apiKey = createApiKey();
      await Users.updateUserApiKeyById(userId, apiKey);
      return new Response(JSON.stringify({ api_key: apiKey }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    },
  },

  // DELETE /{user_id}/api_key — admin
  {
    method: 'DELETE',
    path: ':user_id/api_key',
    auth: 'admin',
    handler: async (ctx) => {
      const sessionUser = requireAdmin(ctx);
      const userId = ctx.params.user_id;
      const targetUser = await Users.getUserById(userId);
      if (!targetUser) err(404, ERROR_MESSAGES.USER_NOT_FOUND);

      const firstUser = await Users.getFirstUser();
      if (firstUser && firstUser.id === userId && sessionUser.id !== userId) {
        err(403, ERROR_MESSAGES.ACTION_PROHIBITED);
      }

      await Users.deleteUserApiKeyById(userId);
      return ctx.json(true);
    },
  },

  // POST /{user_id}/update — admin user update
  {
    method: 'POST',
    path: ':user_id/update',
    auth: 'admin',
    handler: async (ctx) => {
      const sessionUser = requireAdmin(ctx);
      const userId = ctx.params.user_id;

      const form = await ctx.body<{
        role?: string | null;
        name?: string | null;
        email?: string | null;
        profile_image_url?: string | null;
        password?: string | null;
      }>();

      // Prevent modification of the primary admin user by other admins
      const firstUser = await Users.getFirstUser();
      if (firstUser && userId === firstUser.id) {
        if (sessionUser.id !== userId) {
          err(403, ERROR_MESSAGES.ACTION_PROHIBITED);
        }
        // The primary admin cannot demote themselves
        if (form.role !== null && form.role !== undefined && form.role !== 'admin') {
          err(403, ERROR_MESSAGES.ACTION_PROHIBITED);
        }
      }

      const user = await Users.getUserById(userId);
      if (!user) err(400, ERROR_MESSAGES.USER_NOT_FOUND);

      // UserUpdateForm.profile_image_url validator
      let profileImageUrl: string | null = null;
      if (form.profile_image_url !== null && form.profile_image_url !== undefined) {
        try {
          profileImageUrl = validateImageUrl(form.profile_image_url);
        } catch (e) {
          err(422, e instanceof Error ? e.message : 'Invalid profile image URL');
        }
      }

      if (form.email !== null && form.email !== undefined && form.email.toLowerCase() !== user.email) {
        const emailUser = await Users.getUserByEmail(form.email.toLowerCase());
        if (emailUser) err(400, ERROR_MESSAGES.EMAIL_TAKEN);
      }

      if (form.password) {
        if (Buffer.byteLength(form.password, 'utf-8') > 72) {
          err(400, ERROR_MESSAGES.PASSWORD_TOO_LONG);
        }
        const hashed = await getPasswordHash(form.password);
        await Auths.updateUserPasswordById(userId, hashed);
      }

      const updateData: Record<string, unknown> = {};
      if (form.role !== null && form.role !== undefined) updateData.role = form.role;
      if (form.name !== null && form.name !== undefined) updateData.name = form.name;
      if (form.email !== null && form.email !== undefined) {
        updateData.email = form.email.toLowerCase();
      }
      if (profileImageUrl !== null) updateData.profile_image_url = profileImageUrl;

      const updatedUser = Object.keys(updateData).length
        ? await Users.updateUserById(userId, updateData)
        : user;

      if (updatedUser) return ctx.json(userDump(updatedUser));
      err(400, 'Something went wrong :/');
    },
  },

  // DELETE /{user_id} — admin user delete
  {
    method: 'DELETE',
    path: ':user_id',
    auth: 'admin',
    handler: async (ctx) => {
      const sessionUser = requireAdmin(ctx);
      const userId = ctx.params.user_id;

      const firstUser = await Users.getFirstUser();
      if (firstUser && userId === firstUser.id) {
        err(403, ERROR_MESSAGES.ACTION_PROHIBITED);
      }

      if (sessionUser.id !== userId) {
        const result = await Auths.deleteAuthById(userId);
        if (result) return ctx.json(true);
        err(500, DELETE_USER_ERROR);
      }

      // Prevent self-deletion
      err(403, ERROR_MESSAGES.ACTION_PROHIBITED);
    },
  },

  // GET /{user_id}/groups — admin view of a user's groups
  {
    method: 'GET',
    path: ':user_id/groups',
    auth: 'admin',
    handler: async (ctx) => {
      requireAdmin(ctx);
      return ctx.json(await userGroupsResponse(ctx.params.user_id, queryBool(ctx.query.get('include_inherited'))));
    },
  },

  // GET /{user_id}/preview — admin access preview across groups
  {
    method: 'GET',
    path: ':user_id/preview',
    auth: 'admin',
    handler: async (ctx) => {
      requireAdmin(ctx);
      const userId = ctx.params.user_id;
      const targetUser = await Users.getUserById(userId);
      if (!targetUser) err(404, ERROR_MESSAGES.USER_NOT_FOUND);

      const userGroups = await getGroupsByMemberId(userId, true);
      const userGroupIds = new Set(userGroups.map((g) => g.id));

      const allModels = await db.model.findMany();
      const activeModels = allModels.filter((m) => m.is_active === true);
      const ownedModelIds = new Set(activeModels.filter((m) => m.user_id === userId).map((m) => m.id));
      const grantedModelIds = await getAccessibleResourceIds(
        userId,
        'model',
        activeModels.filter((m) => m.user_id !== userId).map((m) => m.id),
        'read',
        [...userGroupIds]
      );
      const accessibleModelIds = new Set([...ownedModelIds, ...grantedModelIds]);

      const allKnowledge = await db.knowledge.findMany();
      const ownedKnowledgeIds = new Set(allKnowledge.filter((k) => k.user_id === userId).map((k) => k.id));
      const grantedKnowledgeIds = await getAccessibleResourceIds(
        userId,
        'knowledge',
        allKnowledge.filter((k) => k.user_id !== userId).map((k) => k.id),
        'read',
        [...userGroupIds]
      );
      const accessibleKnowledgeIds = new Set([...ownedKnowledgeIds, ...grantedKnowledgeIds]);

      const allTools = await getTools({ deferContent: true });
      const ownedToolIds = new Set(allTools.filter((t) => t.user_id === userId).map((t) => t.id));
      const grantedToolIds = await getAccessibleResourceIds(
        userId,
        'tool',
        allTools.filter((t) => t.user_id !== userId).map((t) => t.id),
        'read',
        [...userGroupIds]
      );
      const accessibleToolIds = new Set([...ownedToolIds, ...grantedToolIds]);

      return ctx.json({
        user: { id: targetUser.id, name: targetUser.name },
        groups: userGroups.map((g) => ({ id: g.id, name: g.name })),
        models: {
          items: activeModels
            .filter((m) => accessibleModelIds.has(m.id))
            .map((m) => ({ id: m.id, name: m.name ?? '' })),
          total: activeModels.length,
        },
        knowledge: {
          items: allKnowledge
            .filter((k) => accessibleKnowledgeIds.has(k.id))
            .map((k) => ({ id: k.id, name: k.name ?? '' })),
          total: allKnowledge.length,
        },
        tools: {
          items: allTools
            .filter((t) => accessibleToolIds.has(t.id))
            .map((t) => ({ id: t.id, name: t.name })),
          total: allTools.length,
        },
      });
    },
  },
];

// ---------------------------------------------------------------------------
// Response shape helpers
// ---------------------------------------------------------------------------

/** UserInfoResponse (models/users.py) — fixed field set. */
function toUserInfoResponse(
  user: UserModel,
  groups: Array<{ id: string; name: string }> = [],
  isActive = false
) {
  return {
    status_emoji: user.status_emoji,
    status_message: user.status_message,
    status_expires_at: user.status_expires_at,
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    bio: user.bio,
    last_active_at: user.last_active_at,
    timezone: user.timezone,
    groups,
    is_active: isActive,
  };
}

/** Constructs the UserPermissions response (pydantic field set + defaults). */
function pydanticUserPermissions(source: Record<string, any>): Record<string, any> {
  const section = (name: keyof typeof PYTHON_USER_PERMISSIONS, provided: any): Record<string, boolean> => {
    const defaults = PYTHON_USER_PERMISSIONS[name];
    const out: Record<string, boolean> = {};
    for (const [field, def] of Object.entries(defaults)) {
      const value = provided != null && typeof provided === 'object' ? provided[field] : undefined;
      out[field] = value === undefined ? def : Boolean(value);
    }
    return out;
  };
  return {
    workspace: section('workspace', source.workspace),
    sharing: section('sharing', source.sharing),
    access_grants: section('access_grants', source.access_grants),
    chat: section('chat', source.chat),
    features: section('features', source.features),
    settings: section('settings', source.settings),
  };
}

/** Fallback avatar — public/user.png when present, else an inline PNG. */
function staticUserPng(): Response {
  const candidates = [
    `${process.cwd()}/public/user.png`,
    `${process.cwd()}/../public/user.png`,
  ];
  for (const candidate of candidates) {
    try {
      const bytes = fs.readFileSync(candidate);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    } catch {
      /* try next */
    }
  }
  const fallback = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  return new Response(new Uint8Array(fallback), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
}
