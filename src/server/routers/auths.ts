import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { configGet, configSet } from '@/lib/config';
import { env, ERROR_MESSAGES, DEFAULT_USER_PERMISSIONS } from '@/lib/constants';
import {
  createApiKey,
  createToken,
  decodeToken,
  getPasswordHash,
  parseDuration,
  tokenFromRequest,
  verifyPassword,
} from '@/lib/auth';
import { getPermissions, hasPermission } from '@/lib/access-control';
import {
  Auths,
  AuthModel,
  createSigninResponse,
  getMfaConfig,
  limitAccount,
  updateMfaConfig,
  MFA_CONFIG_KEYS,
  WEBUI_AUTH_COOKIE_SAME_SITE,
  WEBUI_AUTH_COOKIE_SECURE,
} from '@/lib/models/auths';
import { Users, UserModel, validateImageUrl as validateProfileImageUrl } from '@/lib/models/users';
import {
  FIREBASE_AUTH_ENABLED,
  firebaseSignInWithPassword,
  firebaseSignUp,
  firebaseOauthLink,
  mergeFirebaseOauth,
  parseFirebaseUid,
} from '@/lib/firebase-auth';

/**
 * Port of open_webui/routers/auths.py (v0.12.5) — /api/v1/auths/*.
 *
 * Stubs / intentional deviations (see task report):
 *   • LDAP bind/search requires an LDAP client — endpoints keep the exact
 *     config gates + error payloads; the bind itself returns the generic
 *     Python catch-all error 'LDAP authentication failed.'
 *   • publish_event / socket disconnects are no-ops (no event bus).
 *   • invalidate_token is a no-op without Redis; signout still clears cookies.
 */

// ---------------------------------------------------------------------------
// Local env mirrors (Python env.py/config.py defaults not in constants.ts)
// ---------------------------------------------------------------------------

const envBool = (key: string, def: string) => (process.env[key] ?? def).toLowerCase() === 'true';

const ENABLE_PASSWORD_AUTH = envBool('ENABLE_PASSWORD_AUTH', 'True');
const WEBUI_AUTH_TRUSTED_EMAIL_HEADER = process.env.WEBUI_AUTH_TRUSTED_EMAIL_HEADER || '';
const WEBUI_AUTH_TRUSTED_NAME_HEADER = process.env.WEBUI_AUTH_TRUSTED_NAME_HEADER || '';
const WEBUI_AUTH_TRUSTED_ROLE_HEADER = process.env.WEBUI_AUTH_TRUSTED_ROLE_HEADER || '';
const WEBUI_AUTH_SIGNOUT_REDIRECT_URL = process.env.WEBUI_AUTH_SIGNOUT_REDIRECT_URL || '';
const ENABLE_INITIAL_ADMIN_SIGNUP = env.ENABLE_INITIAL_ADMIN_SIGNUP;
const ENABLE_OAUTH_TOKEN_EXCHANGE = envBool('ENABLE_OAUTH_TOKEN_EXCHANGE', 'False');

// Error messages missing from the frozen constants.ts (Python strings)
const INCORRECT_PASSWORD = 'The password provided is incorrect. Please check for typos and try again.';
const INVALID_TRUSTED_HEADER =
  'Your provider has not provided a trusted header. Please contact your administrator for assistance.';
const CREATE_API_KEY_ERROR =
  'Oops! Something went wrong while creating your API key. Please try again later. If the issue persists, contact support for assistance.';
const API_KEY_CREATION_NOT_ALLOWED = 'API key creation is not allowed in the environment.';
const REQUIRED_FIELD_EMPTY = (name: string) => `Required field ${name} is empty`;
const OAUTH_NOT_CONFIGURED = (name: string) => `Provider '${name}' is not configured`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const nowSec = () => Math.floor(Date.now() / 1000);

function jsonWithCookies(data: unknown, cookies: string[], status = 200): Response {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

function sessionCookie(token: string, maxAge: number | null): string {
  let cookie = `token=${token}; Path=/; HttpOnly; SameSite=${WEBUI_AUTH_COOKIE_SAME_SITE}`;
  if (WEBUI_AUTH_COOKIE_SECURE) cookie += '; Secure';
  if (maxAge !== null && maxAge !== undefined) cookie += `; Max-Age=${Math.floor(maxAge)}`;
  return cookie;
}

function deletedCookie(name: string, path = '/'): string {
  return `${name}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=${path}; HttpOnly; SameSite=${WEBUI_AUTH_COOKIE_SAME_SITE}`;
}

/** Token from Authorization header, then the `token` cookie (Python parity). */
function tokenFromAuthOrCookie(req: Request): string | null {
  const authHeader = req.headers.get('authorization');
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2) return parts[1];
  }
  const cookie = req.headers.get('cookie');
  if (cookie) {
    const m = cookie.match(/(?:^|;\s*)token=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

/** Python: get_human_user — requires a JWT session (not an API key). */
function requireHumanUser(ctx: Ctx): void {
  const token = tokenFromAuthOrCookie(ctx.req) ?? tokenFromRequest(ctx.req);
  if (!token || token.startsWith('sk-')) ctx.error(403, 'A human session is required.');
  const decoded = decodeToken(token);
  if (!decoded || String(decoded.typ ?? 'session') !== 'session') {
    ctx.error(403, 'A human session is required.');
  }
}

/** Python: get_verified_user — role must be user/admin. */
function requireVerifiedUser(ctx: Ctx) {
  const user = ctx.user;
  if (!user) ctx.error(401, 'Not authenticated');
  if (!['user', 'admin'].includes(user.role)) ctx.error(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
  return user;
}

/** Python: get_http_authorization_cred-style body field requirements. */
function requireString(body: Record<string, unknown>, key: string): string {
  const value = body?.[key];
  if (typeof value !== 'string') throw new HttpError(422, `Field required: '${key}'`);
  return value;
}

function throwHttp(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

/** Python: validate_email_format. */
function validateEmailFormat(email: string): boolean {
  if (email.endsWith('@localhost')) return true;
  return /^[^@]+@[^@]+\.[^@]+$/.test(email);
}

/** Python: validate_password (bcrypt 72-byte limit; no regex validation env). */
function validatePassword(password: string): void {
  if (Buffer.byteLength(password, 'utf-8') > 72) {
    throw new HttpError(400, ERROR_MESSAGES.PASSWORD_TOO_LONG);
  }
}

/** Python: RateLimiter (in-memory rolling window). */
class RateLimiter {
  private buckets = new Map<number, Map<string, number>>();

  constructor(
    public limit: number,
    public window: number,
    public bucketSize = 60
  ) {}

  isLimited(key: string): boolean {
    const nowBucket = Math.floor(nowSec() / this.bucketSize);
    const numBuckets = Math.floor(this.window / this.bucketSize);
    for (const bucketIndex of [...this.buckets.keys()]) {
      if (bucketIndex < nowBucket - numBuckets) this.buckets.delete(bucketIndex);
    }
    const current = this.buckets.get(nowBucket) ?? new Map<string, number>();
    current.set(key, (current.get(key) ?? 0) + 1);
    this.buckets.set(nowBucket, current);
    let total = 0;
    for (const bucketCounts of this.buckets.values()) total += bucketCounts.get(key) ?? 0;
    return total > this.limit;
  }
}

// 5 failed attempts per email per minute (per port contract; upstream uses 15/180s)
const signinRateLimiter = new RateLimiter(5, 60);

// ---------------------------------------------------------------------------
// Config helpers (Python Config.get_many semantics: DB row or DEFAULT_CONFIG
// default — only keys present in either)
// ---------------------------------------------------------------------------

function envDefault(key: string, def: unknown): unknown {
  return process.env[key] !== undefined ? process.env[key] : def;
}

/** defaults mirroring open_webui/config.py DEFAULT_CONFIG for ADMIN_CONFIG_KEYS */
const ADMIN_CONFIG_DEFAULTS: Record<string, unknown> = {
  'auth.mfa.enable': env.ENABLE_MFA,
  'auth.mfa.allow_oauth_bypass': envBool('MFA_ALLOW_OAUTH_BYPASS', 'False'),
  'auth.mfa.allow_trusted_header_bypass': envBool('MFA_ALLOW_TRUSTED_HEADER_BYPASS', 'False'),
  'auth.admin.show': envBool('SHOW_ADMIN_DETAILS', 'true'),
  'auth.admin.email': envDefault('ADMIN_EMAIL', null),
  'webui.url': envDefault('WEBUI_URL', ''),
  'ui.enable_login_form': env.ENABLE_LOGIN_FORM,
  'ui.enable_signup': env.ENABLE_SIGNUP,
  'auth.enable_api_keys': env.ENABLE_API_KEY,
  'auth.api_key.endpoint_restrictions': envBool('ENABLE_API_KEYS_ENDPOINT_RESTRICTIONS', 'False'),
  'auth.api_key.allowed_endpoints': envDefault('API_KEYS_ALLOWED_ENDPOINTS', envDefault('API_KEY_ALLOWED_ENDPOINTS', '')),
  'ui.default_user_role': env.DEFAULT_USER_ROLE,
  'ui.default_group_id': envDefault('DEFAULT_GROUP_ID', ''),
  'ui.default_interface_settings': (() => {
    try {
      return JSON.parse(process.env.DEFAULT_INTERFACE_SETTINGS || '{}');
    } catch {
      return {};
    }
  })(),
  'ui.i18n': {},
  'auth.jwt_expiry': env.JWT_EXPIRES_IN,
  'ui.enable_community_sharing': envBool('ENABLE_COMMUNITY_SHARING', 'True'),
  'ui.enable_message_rating': envBool('ENABLE_MESSAGE_RATING', 'True'),
  'folders.enable': env.ENABLE_FOLDERS,
  'folders.max_file_count': envDefault('FOLDER_MAX_FILE_COUNT', ''),
  'automations.max_count': envDefault('AUTOMATION_MAX_COUNT', ''),
  'automations.min_interval': envDefault('AUTOMATION_MIN_INTERVAL', ''),
  'automations.enable': envBool('ENABLE_AUTOMATIONS', 'True'),
  'channels.enable': env.ENABLE_CHANNELS,
  'channels.encryption.enable': envBool('ENABLE_ENCRYPTED_CHANNELS', 'False'),
  'apps.enable': env.ENABLE_APPS,
  'channels.model_response_mode': envDefault('CHANNEL_MODEL_RESPONSE_MODE', 'thread'),
  'calendar.enable': envBool('ENABLE_CALENDAR', 'True'),
  'memories.enable': env.ENABLE_MEMORIES,
  'memories.system_context.enable': envBool('ENABLE_MEMORY_SYSTEM_CONTEXT', 'True'),
  'skills.lazy_loading.enable': envBool('ENABLE_SKILL_LAZY_LOADING', 'False'),
  'skills.catalog.enable': envBool('ENABLE_SKILL_CATALOG', 'True'),
  'skills.content_max_chars': process.env.SKILL_CONTENT_MAX_CHARS ? parseInt(process.env.SKILL_CONTENT_MAX_CHARS, 10) : null,
  'skills.preview_max_chars': process.env.SKILL_PREVIEW_MAX_CHARS ? parseInt(process.env.SKILL_PREVIEW_MAX_CHARS, 10) : null,
  'notes.enable': env.ENABLE_NOTES,
  'ui.enable_user_webhooks': envBool('ENABLE_USER_WEBHOOKS', 'False'),
  'users.enable_status': envBool('ENABLE_USER_STATUS', 'True'),
  'ui.pending_user_overlay_title': envDefault('PENDING_USER_OVERLAY_TITLE', ''),
  'ui.pending_user_overlay_content': envDefault('PENDING_USER_OVERLAY_CONTENT', ''),
  'ui.watermark': envDefault('RESPONSE_WATERMARK', ''),
};

const ADMIN_CONFIG_KEYS: Record<string, string> = {
  ENABLE_MFA: 'auth.mfa.enable',
  MFA_ALLOW_OAUTH_BYPASS: 'auth.mfa.allow_oauth_bypass',
  MFA_ALLOW_TRUSTED_HEADER_BYPASS: 'auth.mfa.allow_trusted_header_bypass',
  SHOW_ADMIN_DETAILS: 'auth.admin.show',
  ADMIN_EMAIL: 'auth.admin.email',
  WEBUI_URL: 'webui.url',
  ENABLE_LOGIN_FORM: 'ui.enable_login_form',
  ENABLE_SIGNUP: 'ui.enable_signup',
  ENABLE_API_KEYS: 'auth.enable_api_keys',
  ENABLE_API_KEYS_ENDPOINT_RESTRICTIONS: 'auth.api_key.endpoint_restrictions',
  API_KEYS_ALLOWED_ENDPOINTS: 'auth.api_key.allowed_endpoints',
  DEFAULT_USER_ROLE: 'ui.default_user_role',
  DEFAULT_GROUP_ID: 'ui.default_group_id',
  DEFAULT_INTERFACE_SETTINGS: 'ui.default_interface_settings',
  I18N: 'ui.i18n',
  JWT_EXPIRES_IN: 'auth.jwt_expiry',
  ENABLE_COMMUNITY_SHARING: 'ui.enable_community_sharing',
  ENABLE_MESSAGE_RATING: 'ui.enable_message_rating',
  ENABLE_FOLDERS: 'folders.enable',
  FOLDER_MAX_FILE_COUNT: 'folders.max_file_count',
  AUTOMATION_MAX_COUNT: 'automations.max_count',
  AUTOMATION_MIN_INTERVAL: 'automations.min_interval',
  ENABLE_AUTOMATIONS: 'automations.enable',
  ENABLE_CHANNELS: 'channels.enable',
  ENABLE_ENCRYPTED_CHANNELS: 'channels.encryption.enable',
  ENABLE_APPS: 'apps.enable',
  CHANNEL_MODEL_RESPONSE_MODE: 'channels.model_response_mode',
  ENABLE_CALENDAR: 'calendar.enable',
  ENABLE_MEMORIES: 'memories.enable',
  ENABLE_MEMORY_SYSTEM_CONTEXT: 'memories.system_context.enable',
  ENABLE_SKILL_LAZY_LOADING: 'skills.lazy_loading.enable',
  ENABLE_SKILL_CATALOG: 'skills.catalog.enable',
  SKILL_CONTENT_MAX_CHARS: 'skills.content_max_chars',
  SKILL_PREVIEW_MAX_CHARS: 'skills.preview_max_chars',
  ENABLE_NOTES: 'notes.enable',
  ENABLE_USER_WEBHOOKS: 'ui.enable_user_webhooks',
  ENABLE_USER_STATUS: 'users.enable_status',
  PENDING_USER_OVERLAY_TITLE: 'ui.pending_user_overlay_title',
  PENDING_USER_OVERLAY_CONTENT: 'ui.pending_user_overlay_content',
  RESPONSE_WATERMARK: 'ui.watermark',
};

const LDAP_SERVER_CONFIG_KEYS: Record<string, string> = {
  label: 'ldap.server.label',
  host: 'ldap.server.host',
  port: 'ldap.server.port',
  attribute_for_mail: 'ldap.server.attribute_for_mail',
  default_email_domain: 'ldap.server.default_email_domain',
  attribute_for_username: 'ldap.server.attribute_for_username',
  app_dn: 'ldap.server.app_dn',
  app_dn_password: 'ldap.server.app_password',
  search_base: 'ldap.server.users_dn',
  search_filters: 'ldap.server.search_filter',
  use_tls: 'ldap.server.use_tls',
  certificate_path: 'ldap.server.ca_cert_file',
  validate_cert: 'ldap.server.validate_cert',
  ciphers: 'ldap.server.ciphers',
  enable_group_management: 'ldap.group.enable_management',
  enable_group_creation: 'ldap.group.enable_creation',
  attribute_for_groups: 'ldap.server.attribute_for_groups',
};

const LDAP_SERVER_CONFIG_DEFAULTS: Record<string, unknown> = {
  'ldap.server.label': envDefault('LDAP_SERVER_LABEL', 'LDAP Server'),
  'ldap.server.host': envDefault('LDAP_SERVER_HOST', 'localhost'),
  'ldap.server.port': process.env.LDAP_SERVER_PORT ? parseInt(process.env.LDAP_SERVER_PORT, 10) : 389,
  'ldap.server.attribute_for_mail': envDefault('LDAP_ATTRIBUTE_FOR_MAIL', 'mail'),
  'ldap.server.default_email_domain': envDefault('LDAP_DEFAULT_EMAIL_DOMAIN', ''),
  'ldap.server.attribute_for_username': envDefault('LDAP_ATTRIBUTE_FOR_USERNAME', 'uid'),
  'ldap.server.app_dn': envDefault('LDAP_APP_DN', ''),
  'ldap.server.app_password': envDefault('LDAP_APP_PASSWORD', ''),
  'ldap.server.users_dn': envDefault('LDAP_SEARCH_BASE', ''),
  'ldap.server.search_filter': envDefault('LDAP_SEARCH_FILTER', envDefault('LDAP_SEARCH_FILTERS', '')),
  'ldap.server.use_tls': envBool('LDAP_USE_TLS', 'True'),
  'ldap.server.ca_cert_file': envDefault('LDAP_CA_CERT_FILE', ''),
  'ldap.server.validate_cert': envBool('LDAP_VALIDATE_CERT', 'True'),
  'ldap.server.ciphers': envDefault('LDAP_CIPHERS', 'ALL'),
  'ldap.group.enable_management': envBool('ENABLE_LDAP_GROUP_MANAGEMENT', 'False'),
  'ldap.group.enable_creation': envBool('ENABLE_LDAP_GROUP_CREATION', 'False'),
  'ldap.server.attribute_for_groups': envDefault('LDAP_ATTRIBUTE_FOR_GROUPS', 'memberOf'),
};

const OAUTH_CONFIG_KEYS: Record<string, string> = {
  ENABLE_OAUTH: 'oauth.enable',
  ENABLE_OAUTH_SIGNUP: 'oauth.enable_signup',
  OAUTH_MERGE_ACCOUNTS_BY_EMAIL: 'oauth.merge_accounts_by_email',
  OAUTH_AUTO_REDIRECT: 'oauth.auto_redirect',
  OAUTH_ALLOWED_DOMAINS: 'oauth.allowed_domains',
  OAUTH_BLOCKED_GROUPS: 'oauth.blocked_groups',
  ENABLE_OAUTH_ROLE_MANAGEMENT: 'oauth.enable_role_mapping',
  OAUTH_ROLES_CLAIM: 'oauth.roles_claim',
  OAUTH_ADMIN_ROLES: 'oauth.admin_roles',
  OAUTH_ALLOWED_ROLES: 'oauth.allowed_roles',
  ENABLE_OAUTH_GROUP_MANAGEMENT: 'oauth.enable_group_mapping',
  ENABLE_OAUTH_GROUP_CREATION: 'oauth.enable_group_creation',
  OAUTH_GROUP_CLAIM: 'oauth.group_claim',
  OAUTH_GROUP_DEFAULT_SHARE: 'oauth.group_default_share',
  OAUTH_PROVIDER_NAME: 'oauth.provider_name',
  OPENID_PROVIDER_URL: 'oauth.provider_url',
  OAUTH_CLIENT_ID: 'oauth.client_id',
  OAUTH_CLIENT_SECRET: 'oauth.client_secret',
  OPENID_REDIRECT_URI: 'oauth.redirect_uri',
  OAUTH_SCOPES: 'oauth.scopes',
  OAUTH_CODE_CHALLENGE_METHOD: 'oauth.code_challenge_method',
  OAUTH_TOKEN_ENDPOINT_AUTH_METHOD: 'oauth.token_endpoint_auth_method',
  OPENID_END_SESSION_ENDPOINT: 'oauth.end_session_endpoint',
  OAUTH_TIMEOUT: 'oauth.timeout',
  OAUTH_CLIENT_TIMEOUT: 'oauth.client.timeout',
  OAUTH_EMAIL_CLAIM: 'oauth.email_claim',
  OAUTH_USERNAME_CLAIM: 'oauth.username_claim',
  OAUTH_PICTURE_CLAIM: 'oauth.picture_claim',
  OAUTH_SUB_CLAIM: 'oauth.sub_claim',
  OAUTH_AUDIENCE: 'oauth.audience',
  OAUTH_UPDATE_EMAIL_ON_LOGIN: 'oauth.update_email_on_login',
  OAUTH_UPDATE_NAME_ON_LOGIN: 'oauth.update_name_on_login',
  OAUTH_UPDATE_PICTURE_ON_LOGIN: 'oauth.update_picture_on_login',
  OAUTH_REFRESH_TOKEN_INCLUDE_SCOPE: 'oauth.refresh_token.include_scope',
};

// oauth.* keys are non-persistent by default (Config.OAUTH_PERSISTENT_ENABLED=False)
const ENABLE_OAUTH_PERSISTENT_CONFIG = envBool('ENABLE_OAUTH_PERSISTENT_CONFIG', 'False');
const OAUTH_PERSISTENT_ENABLED = ENABLE_OAUTH_PERSISTENT_CONFIG;

function oauthGroupDefaultShare(): boolean | string {
  const raw = process.env.OAUTH_GROUP_DEFAULT_SHARE ?? '';
  if (raw === 'members') return 'members';
  return raw === 'true';
}

/** env-derived defaults for oauth.* keys (mirrors DEFAULT_CONFIG) */
const OAUTH_CONFIG_DEFAULTS: Record<string, unknown> = {
  'oauth.enable': env.ENABLE_OAUTH,
  'oauth.enable_signup': envBool('ENABLE_OAUTH_SIGNUP', 'False'),
  'oauth.merge_accounts_by_email': envBool('OAUTH_MERGE_ACCOUNTS_BY_EMAIL', 'False'),
  'oauth.auto_redirect': envBool('OAUTH_AUTO_REDIRECT', 'False'),
  'oauth.allowed_domains': (process.env.OAUTH_ALLOWED_DOMAINS || '*')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean),
  'oauth.blocked_groups': envDefault('OAUTH_BLOCKED_GROUPS', '[]'),
  'oauth.enable_role_mapping': envBool('ENABLE_OAUTH_ROLE_MANAGEMENT', 'False'),
  'oauth.roles_claim': envDefault('OAUTH_ROLES_CLAIM', 'roles'),
  'oauth.admin_roles': (process.env.OAUTH_ADMIN_ROLES || 'admin')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean),
  'oauth.allowed_roles': (process.env.OAUTH_ALLOWED_ROLES || 'user,admin')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean),
  'oauth.enable_group_mapping': envBool('ENABLE_OAUTH_GROUP_MANAGEMENT', 'False'),
  'oauth.enable_group_creation': envBool('ENABLE_OAUTH_GROUP_CREATION', 'False'),
  'oauth.group_claim': envDefault('OAUTH_GROUP_CLAIM', 'groups'),
  'oauth.group_default_share': oauthGroupDefaultShare(),
  'oauth.provider_name': envDefault('OAUTH_PROVIDER_NAME', 'SSO'),
  'oauth.provider_url': envDefault('OPENID_PROVIDER_URL', ''),
  'oauth.client_id': envDefault('OAUTH_CLIENT_ID', ''),
  'oauth.client_secret': envDefault('OAUTH_CLIENT_SECRET', ''),
  'oauth.redirect_uri': envDefault('OPENID_REDIRECT_URI', ''),
  'oauth.scopes': envDefault('OAUTH_SCOPES', 'openid email profile'),
  'oauth.code_challenge_method': envDefault('OAUTH_CODE_CHALLENGE_METHOD', null),
  'oauth.token_endpoint_auth_method': envDefault('OAUTH_TOKEN_ENDPOINT_AUTH_METHOD', null),
  'oauth.end_session_endpoint': envDefault('OPENID_END_SESSION_ENDPOINT', ''),
  'oauth.timeout': envDefault('OAUTH_TIMEOUT', ''),
  'oauth.client.timeout': envDefault('OAUTH_CLIENT_TIMEOUT', ''),
  'oauth.email_claim': envDefault('OAUTH_EMAIL_CLAIM', 'email'),
  'oauth.username_claim': envDefault('OAUTH_USERNAME_CLAIM', 'name'),
  'oauth.picture_claim': envDefault('OAUTH_PICTURE_CLAIM', 'picture'),
  'oauth.sub_claim': envDefault('OAUTH_SUB_CLAIM', null),
  'oauth.audience': envDefault('OAUTH_AUDIENCE', ''),
  'oauth.update_email_on_login': envBool('OAUTH_UPDATE_EMAIL_ON_LOGIN', 'False'),
  'oauth.update_name_on_login': envBool('OAUTH_UPDATE_NAME_ON_LOGIN', 'False'),
  'oauth.update_picture_on_login': envBool('OAUTH_UPDATE_PICTURE_ON_LOGIN', 'False'),
  'oauth.refresh_token.include_scope': envBool('OAUTH_REFRESH_TOKEN_INCLUDE_SCOPE', 'False'),
};

// in-memory DEFAULTS overrides written by POST /admin/config/oauth when
// oauth persistence is disabled (Config.upsert writes to Config.DEFAULTS)
const oauthDefaultsOverlay = new Map<string, unknown>();

async function configGetManyRaw(
  keys: string[],
  defaults: Record<string, unknown>,
  opts: { oauthPersistent?: boolean } = {}
): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  const dbKeys = opts.oauthPersistent ? keys : keys.filter((k) => !k.startsWith('oauth.'));
  if (dbKeys.length) {
    const rows = await db.config.findMany({ where: { key: { in: dbKeys } } });
    for (const row of rows) {
      try {
        values[row.key] = JSON.parse(row.value);
      } catch {
        values[row.key] = row.value;
      }
    }
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in values) out[key] = values[key];
    else if (key.startsWith('oauth.') && oauthDefaultsOverlay.has(key)) out[key] = oauthDefaultsOverlay.get(key);
    else if (key in defaults) out[key] = defaults[key];
  }
  return out;
}

async function configUpsertMap(updates: Record<string, unknown>, opts: { oauthPersistent?: boolean } = {}): Promise<void> {
  for (const [key, value] of Object.entries(updates)) {
    if (key.startsWith('oauth.') && !opts.oauthPersistent) {
      oauthDefaultsOverlay.set(key, value);
      continue;
    }
    await configSet(key, value);
  }
}

async function getConfigValues(
  keyMap: Record<string, string>,
  defaults: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const values = await configGetManyRaw(Object.values(keyMap), defaults);
  const out: Record<string, unknown> = {};
  for (const [field, storageKey] of Object.entries(keyMap)) {
    if (storageKey in values) out[field] = values[storageKey];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared signup / group helpers
// ---------------------------------------------------------------------------

/** Python: apply_default_group_assignment (utils/groups.py). */
async function applyDefaultGroupAssignment(defaultGroupId: string, userId: string): Promise<void> {
  if (!defaultGroupId) return;
  try {
    const group = await db.group.findFirst({ where: { id: defaultGroupId } });
    if (!group) return;
    const existing = await db.groupMember.findFirst({ where: { group_id: defaultGroupId, user_id: userId } });
    if (existing) return;
    await db.groupMember.create({
      data: {
        id: crypto.randomUUID(),
        group_id: defaultGroupId,
        user_id: userId,
        created_at: nowSec(),
        updated_at: nowSec(),
      },
    });
    await db.group
      .update({ where: { id: defaultGroupId }, data: { updated_at: nowSec() } })
      .catch(() => undefined);
  } catch {
    // best-effort, mirrors Python error swallow
  }
}

/** Python: signup_handler — creates the user, promotes the first account.
 *  Nelth-AI extension: opts.firebaseUid provisions the account with its
 *  Firebase identity as the local ID (data keyed by the same UID). */
async function signupHandler(
  email: string,
  password: string,
  name: string,
  profileImageUrl = '/user.png',
  source = 'api',
  opts: { firebaseUid?: string; oauth?: Record<string, any> | null } = {}
): Promise<UserModel> {
  const hashed = await getPasswordHash(password);
  const role = await configGet<string>('ui.default_user_role', env.DEFAULT_USER_ROLE);
  let user = await Auths.insertNewAuth(
    email.toLowerCase(),
    hashed,
    name,
    profileImageUrl,
    role,
    opts.oauth ?? null,
    opts.firebaseUid
  );
  if (!user) throw new HttpError(500, ERROR_MESSAGES.CREATE_USER_ERROR);

  // PUBLIC-APP MODE (chatgpt-like): there is no administrator account and no
  // privileged first user — every signup lands as an equal, full member and
  // the sign-up form stays open (this is a public application).

  const defaultGroupId = await configGet<string>('ui.default_group_id', '');
  await applyDefaultGroupAssignment(defaultGroupId, user.id);

  return user;
}

// ---------------------------------------------------------------------------
// Firebase Auth bridge (Nelth-AI addition, opt-in via FIREBASE_API_KEY)
// ---------------------------------------------------------------------------

/**
 * Verify credentials against Firebase Auth and map the Firebase identity onto
 * the local account system:
 *   • existing local account (same email) → linked to its Firebase UID
 *     (user.oauth.firebase.uid) without touching its stable local ID;
 *   • no local account → provisioned with the Firebase UID as its ID, so every
 *     account keeps its own identity and its data (chats, files, memories…)
 *     is keyed by that UID in SQLite (dev) / Supabase Postgres (production).
 *
 * Returns null when Firebase rejects the credentials or is unreachable — the
 * caller then keeps the regular invalid-credentials path.
 */
async function authenticateViaFirebase(
  email: string,
  password: string
): Promise<{ user: UserModel; auth: AuthModel } | null> {
  const fb = await firebaseSignInWithPassword(email, password);
  if (!fb.ok) return null;

  const { uid, email: fbEmail, displayName } = fb.account;

  // 1. Existing local account with this email → link it to the Firebase UID.
  const existing = await Users.getUserByEmail(email);
  if (existing) {
    if (parseFirebaseUid(existing.oauth) !== uid) {
      await Users.updateUserById(existing.id, {
        oauth: mergeFirebaseOauth(existing.oauth, firebaseOauthLink(fb.account)),
      }).catch(() => undefined);
    }
    const authRow = await Auths.getAuthById(existing.id);
    if (authRow && (authRow.active ?? true)) {
      const refreshed = (await Users.getUserById(existing.id)) ?? existing;
      return { user: refreshed, auth: authRow };
    }
    return null;
  }

  // 2. No local account → provision one keyed by the Firebase UID.
  const placeholderHash = await getPasswordHash(`${crypto.randomUUID()}${crypto.randomUUID()}`);
  const name = (displayName ?? '').trim() || fbEmail.split('@')[0] || 'User';
  const role = await configGet<string>('ui.default_user_role', env.DEFAULT_USER_ROLE);
  const user = await Auths.insertNewAuth(
    fbEmail.toLowerCase(),
    placeholderHash,
    name,
    '/user.png',
    role,
    { firebase: firebaseOauthLink(fb.account) },
    uid
  );
  if (!user) return null;

  const defaultGroupId = await configGet<string>('ui.default_group_id', '');
  await applyDefaultGroupAssignment(defaultGroupId, user.id);

  const authRow = await Auths.getAuthById(user.id);
  return authRow ? { user, auth: authRow } : null;
}

/** The AddUserResponse subset shared by /add (FastAPI serializes UserModel through it). */
function addUserSubset(user: UserModel): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    profile_image_url: user.profile_image_url ?? '/user.png',
  };
}

async function checkApiKeyPermission(ctx: Ctx, user: { id: string; role: string }): Promise<void> {
  const enableApiKeys = await configGet<boolean>('auth.enable_api_keys', env.ENABLE_API_KEY);
  if (!enableApiKeys) {
    ctx.error(403, API_KEY_CREATION_NOT_ALLOWED);
  }
  if (user.role !== 'admin') {
    const defaultPermissions = await configGet<Record<string, any> | null>(
      'user.permissions',
      DEFAULT_USER_PERMISSIONS as unknown as Record<string, any>
    );
    if (!(await hasPermission(user.id, 'features.api_keys', defaultPermissions))) {
      ctx.error(403, API_KEY_CREATION_NOT_ALLOWED);
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // ------------------- GET / (get_session_user) -------------------
  {
    method: 'GET',
    path: '',
    auth: 'user',
    handler: async (ctx) => {
      requireHumanUser(ctx);
      const user = (await Users.getUserById(ctx.user!.id))!;
      const token = tokenFromAuthOrCookie(ctx.req);
      const data = token ? decodeToken(token) : null;

      let expiresAt: number | null = null;
      const cookies: string[] = [];
      if (data) {
        expiresAt = typeof data.exp === 'number' ? data.exp : null;
        if (expiresAt !== null && nowSec() > expiresAt) {
          ctx.error(401, ERROR_MESSAGES.INVALID_TOKEN);
        }
        const maxAge = expiresAt !== null ? expiresAt - nowSec() : null;
        cookies.push(sessionCookie(token!, maxAge));
      }

      const userPermissions = await getPermissions(
        user.id,
        await configGet<Record<string, any> | null>(
          'user.permissions',
          DEFAULT_USER_PERMISSIONS as unknown as Record<string, any>
        )
      );

      return jsonWithCookies(
        {
          token,
          token_type: 'Bearer',
          expires_at: expiresAt,
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          profile_image_url: user.profile_image_url,
          bio: user.bio,
          gender: user.gender,
          date_of_birth: user.date_of_birth,
          status_emoji: user.status_emoji,
          status_message: user.status_message,
          status_expires_at: user.status_expires_at,
          permissions: userPermissions,
        },
        cookies
      );
    },
  },

  // ------------------- POST /update/profile -------------------
  {
    method: 'POST',
    path: 'update/profile',
    auth: 'user',
    handler: async (ctx) => {
      const sessionUser = requireVerifiedUser(ctx);
      const form = await ctx.body<Record<string, unknown>>();
      const profileImageUrl = requireString(form, 'profile_image_url');
      const name = requireString(form, 'name');
      let validatedUrl: string;
      try {
        validatedUrl = validateProfileImageUrl(profileImageUrl);
      } catch (e) {
        throwHttp(422, e instanceof Error ? e.message : 'Invalid profile image URL.');
      }
      const updated = await Users.updateUserById(sessionUser.id, {
        profile_image_url: validatedUrl,
        name,
        bio: (form.bio as string | null) ?? null,
        gender: (form.gender as string | null) ?? null,
        date_of_birth: (form.date_of_birth as string | null) ?? null,
      });
      if (updated) {
        // response_model=UserProfileImageResponse → id/name/role/email/profile_image_url
        return ctx.json({
          id: updated.id,
          name: updated.name,
          role: updated.role,
          email: updated.email,
          profile_image_url: updated.profile_image_url,
        });
      }
      return ctx.error(400, '');
    },
  },

  // ------------------- POST /update/timezone -------------------
  {
    method: 'POST',
    path: 'update/timezone',
    auth: 'user',
    handler: async (ctx) => {
      const form = await ctx.body<{ timezone: string }>();
      const timezone = requireString(form as Record<string, unknown>, 'timezone');
      await Users.updateUserById(ctx.user!.id, { timezone });
      return ctx.json({ status: true });
    },
  },

  // ------------------- POST /update/password -------------------
  {
    method: 'POST',
    path: 'update/password',
    auth: 'user',
    handler: async (ctx) => {
      if (WEBUI_AUTH_TRUSTED_EMAIL_HEADER) {
        ctx.error(400, ERROR_MESSAGES.ACTION_PROHIBITED);
      }
      const sessionUser = ctx.user!;
      const form = await ctx.body<Record<string, unknown>>();
      const password = requireString(form, 'password');
      const newPassword = requireString(form, 'new_password');

      const authenticated = await Auths.authenticateUser(sessionUser.email, (pw) => verifyPassword(password, pw));
      if (authenticated) {
        const { user, auth } = authenticated;
        validatePassword(newPassword);
        const hashed = await getPasswordHash(newPassword);
        let success = false;
        try {
          success = await Auths.updateUserPasswordById(user.id, hashed, auth);
        } catch {
          ctx.error(409, 'Authentication changed. Please sign in again.');
        }
        return ctx.json(success);
      }
      return ctx.error(400, INCORRECT_PASSWORD);
    },
  },

  // ------------------- POST /ldap -------------------
  {
    method: 'POST',
    path: 'ldap',
    auth: 'none',
    handler: async (ctx) => {
      if (!(await configGet<boolean>('ldap.enable', false))) {
        ctx.error(400, 'LDAP authentication is not enabled');
      }
      if (!ENABLE_PASSWORD_AUTH) {
        ctx.error(403, ERROR_MESSAGES.ACTION_PROHIBITED);
      }
      const form = await ctx.body<Record<string, unknown>>();
      const password = typeof form.password === 'string' ? form.password : '';
      if (!password || !password.trim()) {
        ctx.error(400, ERROR_MESSAGES.INVALID_CRED);
      }
      // LDAP bind/search requires an LDAP client (not available in this port);
      // upstream returns this same error for any bind/search failure.
      return ctx.error(400, 'LDAP authentication failed.');
    },
  },

  // ------------------- POST /signin -------------------
  {
    method: 'POST',
    path: 'signin',
    auth: 'none',
    handler: async (ctx) => {
      if (!ENABLE_PASSWORD_AUTH) {
        ctx.error(403, ERROR_MESSAGES.ACTION_PROHIBITED);
      }

      const form = await ctx.body<Record<string, unknown>>();
      const email = requireString(form, 'email');
      const password = requireString(form, 'password');

      let authSource = 'password';
      let auth: AuthModel | null = null;
      let user: UserModel | null = null;

      if (WEBUI_AUTH_TRUSTED_EMAIL_HEADER) {
        authSource = 'trusted_header';
        const headerEmail = ctx.req.headers.get(WEBUI_AUTH_TRUSTED_EMAIL_HEADER);
        if (headerEmail === null || headerEmail === undefined) {
          return ctx.error(400, INVALID_TRUSTED_HEADER);
        }
        const trustedEmail = headerEmail.toLowerCase();
        let name = trustedEmail;
        if (WEBUI_AUTH_TRUSTED_NAME_HEADER) {
          const nameHeader = ctx.req.headers.get(WEBUI_AUTH_TRUSTED_NAME_HEADER) ?? trustedEmail;
          try {
            name = decodeURIComponent(nameHeader);
          } catch {
            name = nameHeader;
          }
        }
        if (!(await Users.getUserByEmail(trustedEmail.toLowerCase()))) {
          await signupHandler(trustedEmail, crypto.randomUUID(), name, '/user.png', 'trusted_header');
        }
        user = await Auths.authenticateUserByEmail(trustedEmail);
        if (user) {
          if (WEBUI_AUTH_TRUSTED_ROLE_HEADER) {
            const trustedRole = (ctx.req.headers.get(WEBUI_AUTH_TRUSTED_ROLE_HEADER) || '').toLowerCase().trim();
            if (['admin', 'user', 'pending'].includes(trustedRole)) {
              if (user.role !== trustedRole) {
                const updatedUser = await Users.updateUserRoleById(user.id, trustedRole);
                if (updatedUser) user = updatedUser;
              }
            }
          }
        }
      } else if (!env.WEBUI_AUTH) {
        authSource = 'system';
        const adminEmail = 'admin@localhost';
        const adminPassword = 'admin';
        if (await Users.getUserByEmail(adminEmail.toLowerCase())) {
          const authenticated = await Auths.authenticateUser(adminEmail.toLowerCase(), (pw) =>
            verifyPassword(adminPassword, pw)
          );
          user = authenticated ? authenticated.user : null;
          auth = authenticated ? authenticated.auth : null;
        } else {
          if (await Users.hasUsers()) {
            ctx.error(400, ERROR_MESSAGES.EXISTING_USERS);
          }
          await signupHandler(adminEmail, adminPassword, 'User', '/user.png', 'system');
          const authenticated = await Auths.authenticateUser(adminEmail.toLowerCase(), (pw) =>
            verifyPassword(adminPassword, pw)
          );
          user = authenticated ? authenticated.user : null;
          auth = authenticated ? authenticated.auth : null;
        }
      } else {
        if (signinRateLimiter.isLimited(email.toLowerCase())) {
          ctx.error(429, ERROR_MESSAGES.RATE_LIMIT_EXCEEDED);
        }
        const mfaConfig = await getMfaConfig();
        if (mfaConfig.ENABLE_MFA) {
          const existing = await Users.getUserByEmail(email.toLowerCase());
          if (existing) {
            await limitAccount(existing.id, 'password');
          }
        }
        const authenticated = await Auths.authenticateUser(email.toLowerCase(), (pw) => verifyPassword(password, pw));
        user = authenticated ? authenticated.user : null;
        auth = authenticated ? authenticated.auth : null;

        // Firebase Auth bridge: local credentials rejected → verify against
        // Firebase (each account keeps its Firebase UID as its identity).
        if (!user && FIREBASE_AUTH_ENABLED) {
          const fb = await authenticateViaFirebase(email.toLowerCase(), password);
          if (fb) {
            authSource = 'firebase';
            user = fb.user;
            auth = fb.auth;
          }
        }
      }

      if (user) {
        const result = await createSigninResponse(user, { setCookie: true, source: authSource, auth });
        return jsonWithCookies(result.data, result.cookies);
      }
      return ctx.error(400, ERROR_MESSAGES.INVALID_CRED);
    },
  },

  // ------------------- POST /signup -------------------
  {
    method: 'POST',
    path: 'signup',
    auth: 'none',
    handler: async (ctx) => {
      const form = await ctx.body<Record<string, unknown>>();
      const name = requireString(form, 'name');
      const email = requireString(form, 'email');
      const password = requireString(form, 'password');
      let profileImageUrl = '/user.png';
      if (form.profile_image_url !== undefined && form.profile_image_url !== null) {
        try {
          profileImageUrl = validateProfileImageUrl(form.profile_image_url);
        } catch (e) {
          throwHttp(422, e instanceof Error ? e.message : 'Invalid profile image URL.');
        }
      }

      const hasUsers = await Users.hasUsers();

      if (env.WEBUI_AUTH) {
        if (hasUsers) {
          const enableSignup = await configGet<boolean>('ui.enable_signup', env.ENABLE_SIGNUP);
          const enableLoginForm = await configGet<boolean>('ui.enable_login_form', env.ENABLE_LOGIN_FORM);
          if (!enableSignup || !enableLoginForm) {
            ctx.error(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
          }
        } else if (!(await configGet<boolean>('ui.enable_login_form', env.ENABLE_LOGIN_FORM)) && !ENABLE_INITIAL_ADMIN_SIGNUP) {
          ctx.error(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
        }
      } else if (hasUsers) {
        ctx.error(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      if (!validateEmailFormat(email.toLowerCase())) {
        ctx.error(400, ERROR_MESSAGES.INVALID_EMAIL_FORMAT);
      }
      if (await Users.getUserByEmail(email.toLowerCase())) {
        ctx.error(400, ERROR_MESSAGES.EMAIL_TAKEN);
      }

      try {
        validatePassword(password);

        // Firebase Auth bridge: provision the Firebase account first so the
        // local account is keyed by the Firebase UID from the very start.
        let firebaseUid: string | undefined;
        let firebaseOauth: Record<string, any> | null = null;
        if (FIREBASE_AUTH_ENABLED) {
          const fb = await firebaseSignUp(email.toLowerCase(), password, name);
          if (fb.ok) {
            firebaseUid = fb.account.uid;
            firebaseOauth = { firebase: firebaseOauthLink(fb.account) };
          } else if (fb.failure.kind === 'email_exists') {
            ctx.error(400, ERROR_MESSAGES.EMAIL_TAKEN);
          }
          // network / transient failures → local-only account (password auth
          // keeps working; the account can be linked on the next signin).
        }

        const user = await signupHandler(email, password, name, profileImageUrl, 'password', {
          firebaseUid,
          oauth: firebaseOauth,
        });
        const result = await createSigninResponse(user, { setCookie: true, source: 'password' });
        return jsonWithCookies(result.data, result.cookies);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        return ctx.error(500, 'An internal error occurred during signup.');
      }
    },
  },

  // ------------------- POST /signout -------------------
  {
    method: 'POST',
    path: 'signout',
    auth: 'none',
    handler: async (ctx) => {
      const token = tokenFromAuthOrCookie(ctx.req);
      const oauthSessionId = (() => {
        const cookie = ctx.req.headers.get('cookie');
        if (!cookie) return null;
        const m = cookie.match(/(?:^|;\s*)oauth_session_id=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : null;
      })();
      let session: { id: string; user_id: string; provider: string; token: Record<string, unknown> | null } | null = null;
      if (oauthSessionId) {
        session = await db.oAuthSession
          .findFirst({ where: { id: oauthSessionId } })
          .then((r) => {
            if (!r) return null;
            let tokenJson: Record<string, unknown> | null = null;
            try {
              tokenJson = JSON.parse(r.token);
            } catch {
              tokenJson = null;
            }
            return { id: r.id, user_id: r.user_id, provider: r.provider, token: tokenJson };
          })
          .catch(() => null);
      }

      // invalidate_token requires Redis — no-op here.

      const cookies = [
        deletedCookie('token'),
        deletedCookie('owui-session'),
        deletedCookie('oui-session'),
        deletedCookie('oauth_id_token'),
      ];

      if (oauthSessionId) {
        cookies.push(deletedCookie('oauth_session_id'));
        const openidEndSessionEndpoint = await configGet<string | null>('oauth.end_session_endpoint', null);
        if (openidEndSessionEndpoint) {
          return jsonWithCookies(
            { status: true, redirect_url: openidEndSessionEndpoint },
            cookies
          );
        }
        const openidProviderUrl = await configGet<string | null>('oauth.provider_url', null);
        if (session && openidProviderUrl) {
          // OIDC discovery to find the end_session_endpoint
          try {
            const res = await fetch(openidProviderUrl);
            if (res.status === 200) {
              const openidData = (await res.json()) as Record<string, unknown>;
              const logoutUrl = openidData.end_session_endpoint as string | undefined;
              if (logoutUrl) {
                const oauthIdToken = (session.token?.id_token as string | undefined) ?? '';
                return jsonWithCookies(
                  {
                    status: true,
                    redirect_url:
                      `${logoutUrl}?id_token_hint=${oauthIdToken}` +
                      (WEBUI_AUTH_SIGNOUT_REDIRECT_URL ? `&post_logout_redirect_uri=${WEBUI_AUTH_SIGNOUT_REDIRECT_URL}` : ''),
                  },
                  cookies
                );
              }
            } else {
              throw new Error('Failed to fetch OpenID configuration');
            }
          } catch {
            ctx.error(500, 'Failed to sign out from the OpenID provider.');
          }
        }
      }

      if (WEBUI_AUTH_SIGNOUT_REDIRECT_URL) {
        return jsonWithCookies({ status: true, redirect_url: WEBUI_AUTH_SIGNOUT_REDIRECT_URL }, cookies);
      }

      return jsonWithCookies({ status: true }, cookies);
    },
  },

  // ------------------- DELETE /oauth/sessions/{provider} -------------------
  {
    method: 'DELETE',
    path: 'oauth/sessions/:provider',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireVerifiedUser(ctx);
      const provider = ctx.params.provider;
      const result = await db.oAuthSession
        .deleteMany({ where: { user_id: user.id, provider } })
        .then((r) => r.count > 0)
        .catch(() => false);
      if (!result) {
        ctx.error(404, 'No OAuth session found for this provider');
      }
      return ctx.json(true);
    },
  },

  // ------------------- POST /add (admin) -------------------
  {
    method: 'POST',
    path: 'add',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<Record<string, unknown>>();
      const name = requireString(form, 'name');
      const email = requireString(form, 'email');
      const password = requireString(form, 'password');
      let profileImageUrl = '/user.png';
      if (form.profile_image_url !== undefined && form.profile_image_url !== null) {
        try {
          profileImageUrl = validateProfileImageUrl(form.profile_image_url);
        } catch (e) {
          throwHttp(422, e instanceof Error ? e.message : 'Invalid profile image URL.');
        }
      }
      const role = typeof form.role === 'string' && form.role ? form.role : 'pending';

      if (!validateEmailFormat(email.toLowerCase())) {
        ctx.error(400, ERROR_MESSAGES.INVALID_EMAIL_FORMAT);
      }
      if (await Users.getUserByEmail(email.toLowerCase())) {
        ctx.error(400, ERROR_MESSAGES.EMAIL_TAKEN);
      }

      try {
        validatePassword(password);
        const hashed = await getPasswordHash(password);
        const user = await Auths.insertNewAuth(email.toLowerCase(), hashed, name, profileImageUrl, role);
        if (user) {
          await applyDefaultGroupAssignment(await configGet<string>('ui.default_group_id', ''), user.id);
          const mfaConfig = await getMfaConfig();
          if (mfaConfig.ENABLE_MFA) {
            return ctx.json(addUserSubset(user));
          }
          const auth = await Auths.getAuthById(user.id);
          const expiresDelta = parseDuration(await configGet<string>('auth.jwt_expiry', '-1'));
          const token = createToken(
            { id: user.id, typ: 'session', session_stamp: auth?.session_stamp ?? null },
            expiresDelta
          );
          return ctx.json({
            token,
            token_type: 'Bearer',
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            profile_image_url: `/api/v1/users/${user.id}/profile/image`,
          });
        }
        ctx.error(500, ERROR_MESSAGES.CREATE_USER_ERROR);
        return ctx.error(500, ERROR_MESSAGES.CREATE_USER_ERROR);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        return ctx.error(500, 'An internal error occurred while adding the user.');
      }
    },
  },

  // ------------------- GET /admin/details -------------------
  {
    method: 'GET',
    path: 'admin/details',
    auth: 'user',
    handler: async (ctx) => {
      if (await configGet<boolean>('auth.admin.show', true)) {
        let adminEmail = await configGet<string | null>('auth.admin.email', null);
        let adminName: string | null = null;
        if (adminEmail) {
          const admin = await Users.getUserByEmail(adminEmail);
          if (admin) adminName = admin.name;
        } else {
          const admin = await Users.getFirstUser();
          if (admin) {
            adminEmail = admin.email;
            adminName = admin.name;
          }
        }
        return ctx.json({ name: adminName, email: adminEmail });
      }
      return ctx.error(400, ERROR_MESSAGES.ACTION_PROHIBITED);
    },
  },

  // ------------------- GET /admin/config -------------------
  {
    method: 'GET',
    path: 'admin/config',
    auth: 'admin',
    handler: async (ctx) => {
      return ctx.json(await getConfigValues(ADMIN_CONFIG_KEYS, ADMIN_CONFIG_DEFAULTS));
    },
  },

  // ------------------- POST /admin/config -------------------
  {
    method: 'POST',
    path: 'admin/config',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<Record<string, unknown>>();
      const fieldsSet = new Set(Object.keys(form));

      // I18N validation + cleaning (pydantic field_validator)
      if ('I18N' in form && form.I18N !== undefined) {
        const value = form.I18N;
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throwHttp(422, 'I18N must be a dictionary');
        }
        const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
        const placeholders = (text: string) =>
          new Set(
            [...text.matchAll(/\{\{\s*-?\s*([^},]+)(?:,[^}]+)?\s*\}\}/g)].map((m) => m[1].trim())
          );
        const cleaned: Record<string, Record<string, string>> = {};
        for (const [locale, entries] of Object.entries(value as Record<string, unknown>)) {
          if (!locale.trim() || unsafeKeys.has(locale)) throwHttp(422, `Invalid language: ${locale}`);
          if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
          const translations: Record<string, string> = {};
          for (const [key, text] of Object.entries(entries as Record<string, unknown>)) {
            if (!key.trim() || unsafeKeys.has(key)) throwHttp(422, `Invalid translation key: ${key}`);
            if (typeof text === 'string' && text.trim()) {
              if (placeholders(key).size !== placeholders(text).size) {
                throwHttp(422, `Interpolation placeholders do not match: ${locale}: ${key}`);
              }
              translations[key] = text;
            }
          }
          if (Object.keys(translations).length) cleaned[locale] = translations;
        }
        form.I18N = cleaned;
      }

      // config_updates: only fields present in the key map
      const updates: Record<string, unknown> = {};
      for (const [field, storageKey] of Object.entries(ADMIN_CONFIG_KEYS)) {
        if (field in form) updates[storageKey] = form[field];
      }

      // unset-sensitive fields are dropped
      for (const field of Object.keys(MFA_CONFIG_KEYS)) {
        if (!fieldsSet.has(field)) delete updates[MFA_CONFIG_KEYS[field]];
      }
      const unsetDropped: Record<string, string> = {
        ENABLE_LOGIN_FORM: 'ui.enable_login_form',
        ENABLE_ENCRYPTED_CHANNELS: 'channels.encryption.enable',
        ENABLE_APPS: 'apps.enable',
        I18N: 'ui.i18n',
        ENABLE_SKILL_LAZY_LOADING: 'skills.lazy_loading.enable',
        ENABLE_SKILL_CATALOG: 'skills.catalog.enable',
        SKILL_CONTENT_MAX_CHARS: 'skills.content_max_chars',
        SKILL_PREVIEW_MAX_CHARS: 'skills.preview_max_chars',
      };
      for (const [field, storageKey] of Object.entries(unsetDropped)) {
        if (!fieldsSet.has(field)) delete updates[storageKey];
      }

      updates['ui.default_interface_settings'] = form.DEFAULT_INTERFACE_SETTINGS || {};
      updates['folders.max_file_count'] = form.FOLDER_MAX_FILE_COUNT ? intOrNull(form.FOLDER_MAX_FILE_COUNT) ?? '' : '';
      updates['automations.max_count'] = form.AUTOMATION_MAX_COUNT ? intOrNull(form.AUTOMATION_MAX_COUNT) ?? '' : '';
      updates['automations.min_interval'] = form.AUTOMATION_MIN_INTERVAL ? intOrNull(form.AUTOMATION_MIN_INTERVAL) ?? '' : '';

      if (form.DEFAULT_USER_ROLE !== undefined && !['pending', 'user', 'admin'].includes(String(form.DEFAULT_USER_ROLE))) {
        delete updates['ui.default_user_role'];
      }
      if (
        form.CHANNEL_MODEL_RESPONSE_MODE !== undefined &&
        !['thread', 'channel'].includes(String(form.CHANNEL_MODEL_RESPONSE_MODE))
      ) {
        delete updates['channels.model_response_mode'];
      }
      const pattern = /^(-1|0|(-?\d+(\.\d+)?)(ms|s|m|h|d|w))$/;
      if (form.JWT_EXPIRES_IN === undefined || !pattern.test(String(form.JWT_EXPIRES_IN))) {
        delete updates['auth.jwt_expiry'];
      }

      // human admin session requirement for MFA changes
      const token = tokenFromAuthOrCookie(ctx.req) ?? tokenFromRequest(ctx.req);
      const decoded = token && !token.startsWith('sk-') ? decodeToken(token) : null;
      const isHumanAdminSession = Boolean(decoded && String(decoded.typ ?? 'session') === 'session');
      const changed = await updateMfaConfig(isHumanAdminSession, updates);

      return ctx.json({
        ...(await getConfigValues(ADMIN_CONFIG_KEYS, ADMIN_CONFIG_DEFAULTS)),
        sessions_revoked: changed,
      });
    },
  },

  // ------------------- GET /admin/config/ldap/server -------------------
  {
    method: 'GET',
    path: 'admin/config/ldap/server',
    auth: 'admin',
    handler: async (ctx) => {
      return ctx.json(await getConfigValues(LDAP_SERVER_CONFIG_KEYS, LDAP_SERVER_CONFIG_DEFAULTS));
    },
  },

  // ------------------- POST /admin/config/ldap/server -------------------
  {
    method: 'POST',
    path: 'admin/config/ldap/server',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<Record<string, unknown>>();
      const merged: Record<string, unknown> = {
        label: form.label !== undefined ? form.label : 'LDAP Server',
        host: form.host !== undefined ? form.host : 'localhost',
        port: form.port !== undefined ? form.port : 389,
        attribute_for_mail: form.attribute_for_mail !== undefined ? form.attribute_for_mail : 'mail',
        default_email_domain: form.default_email_domain !== undefined ? form.default_email_domain : '',
        attribute_for_username: form.attribute_for_username !== undefined ? form.attribute_for_username : 'uid',
        app_dn: form.app_dn !== undefined ? form.app_dn : '',
        app_dn_password: form.app_dn_password !== undefined ? form.app_dn_password : '',
        search_base: form.search_base !== undefined ? form.search_base : '',
        search_filters: form.search_filters !== undefined ? form.search_filters : '',
        use_tls: form.use_tls !== undefined ? form.use_tls : true,
        certificate_path: form.certificate_path !== undefined ? form.certificate_path : null,
        validate_cert: form.validate_cert !== undefined ? form.validate_cert : true,
        ciphers: form.ciphers !== undefined ? form.ciphers : 'ALL',
        enable_group_management: form.enable_group_management !== undefined ? form.enable_group_management : false,
        enable_group_creation: form.enable_group_creation !== undefined ? form.enable_group_creation : false,
        attribute_for_groups: form.attribute_for_groups !== undefined ? form.attribute_for_groups : 'memberOf',
      };

      const requiredFields = ['label', 'host', 'attribute_for_mail', 'attribute_for_username', 'search_base'];
      for (const key of requiredFields) {
        const value = merged[key];
        if (!value) ctx.error(400, REQUIRED_FIELD_EMPTY(key));
      }
      if (merged.enable_group_management && !String(merged.attribute_for_groups || '').trim()) {
        ctx.error(400, REQUIRED_FIELD_EMPTY('attribute_for_groups'));
      }

      const updates: Record<string, unknown> = {};
      for (const [field, storageKey] of Object.entries(LDAP_SERVER_CONFIG_KEYS)) {
        updates[storageKey] = merged[field];
      }
      updates['ldap.server.app_dn'] = merged.app_dn || '';
      updates['ldap.server.app_password'] = merged.app_dn_password || '';
      await configUpsertMap(updates);
      return ctx.json(await getConfigValues(LDAP_SERVER_CONFIG_KEYS, LDAP_SERVER_CONFIG_DEFAULTS));
    },
  },

  // ------------------- GET /admin/config/ldap -------------------
  {
    method: 'GET',
    path: 'admin/config/ldap',
    auth: 'admin',
    handler: async (ctx) => {
      return ctx.json({ ENABLE_LDAP: await configGet<boolean>('ldap.enable', false) });
    },
  },

  // ------------------- POST /admin/config/ldap -------------------
  {
    method: 'POST',
    path: 'admin/config/ldap',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<{ enable_ldap?: boolean | null }>();
      await configSet('ldap.enable', form.enable_ldap ?? null);
      return ctx.json({ ENABLE_LDAP: await configGet<boolean>('ldap.enable', false) });
    },
  },

  // ------------------- GET /admin/config/oauth -------------------
  {
    method: 'GET',
    path: 'admin/config/oauth',
    auth: 'admin',
    handler: async (ctx) => {
      const values = await configGetManyRaw(Object.values(OAUTH_CONFIG_KEYS), OAUTH_CONFIG_DEFAULTS, {
        oauthPersistent: ENABLE_OAUTH_PERSISTENT_CONFIG,
      });
      const formValues: Record<string, unknown> = {};
      for (const [field, storageKey] of Object.entries(OAUTH_CONFIG_KEYS)) {
        if (storageKey in values) formValues[field] = formatOauthFormValue(field, values[storageKey]);
      }
      formValues['ENABLE_OAUTH_PERSISTENT_CONFIG'] = OAUTH_PERSISTENT_ENABLED;
      return ctx.json(formValues);
    },
  },

  // ------------------- POST /admin/config/oauth -------------------
  {
    method: 'POST',
    path: 'admin/config/oauth',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<Record<string, unknown>>();
      const updates: Record<string, unknown> = {};
      for (const [field, storageKey] of Object.entries(OAUTH_CONFIG_KEYS)) {
        if (field in form && form[field] !== null && form[field] !== undefined) {
          updates[storageKey] = parseOauthUpdateValue(field, form[field]);
        }
      }
      await configUpsertMap(updates, { oauthPersistent: ENABLE_OAUTH_PERSISTENT_CONFIG });
      const values = await configGetManyRaw(Object.values(OAUTH_CONFIG_KEYS), OAUTH_CONFIG_DEFAULTS, {
        oauthPersistent: ENABLE_OAUTH_PERSISTENT_CONFIG,
      });
      const formValues: Record<string, unknown> = {};
      for (const [field, storageKey] of Object.entries(OAUTH_CONFIG_KEYS)) {
        if (storageKey in values) formValues[field] = formatOauthFormValue(field, values[storageKey]);
      }
      formValues['ENABLE_OAUTH_PERSISTENT_CONFIG'] = OAUTH_PERSISTENT_ENABLED;
      return ctx.json(formValues);
    },
  },

  // ------------------- POST /api_key -------------------
  {
    method: 'POST',
    path: 'api_key',
    auth: 'user',
    handler: async (ctx) => {
      const user = ctx.user!;
      await checkApiKeyPermission(ctx, user);
      const apiKey = createApiKey();
      const success = await Users.updateUserApiKeyById(user.id, apiKey);
      if (success) {
        return ctx.json({ api_key: apiKey });
      }
      return ctx.error(500, CREATE_API_KEY_ERROR);
    },
  },

  // ------------------- DELETE /api_key -------------------
  {
    method: 'DELETE',
    path: 'api_key',
    auth: 'user',
    handler: async (ctx) => {
      const user = ctx.user!;
      await checkApiKeyPermission(ctx, user);
      const success = await Users.deleteUserApiKeyById(user.id);
      return ctx.json(success);
    },
  },

  // ------------------- GET /api_key -------------------
  {
    method: 'GET',
    path: 'api_key',
    auth: 'user',
    handler: async (ctx) => {
      const user = ctx.user!;
      await checkApiKeyPermission(ctx, user);
      const apiKey = await Users.getUserApiKeyById(user.id);
      if (apiKey) {
        return ctx.json({ api_key: apiKey });
      }
      return ctx.error(404, ERROR_MESSAGES.API_KEY_NOT_FOUND);
    },
  },

  // ------------------- POST /oauth/{provider}/token/exchange -------------------
  {
    method: 'POST',
    path: 'oauth/:provider/token/exchange',
    auth: 'none',
    handler: async (ctx) => {
      if (!ENABLE_OAUTH_TOKEN_EXCHANGE) {
        ctx.error(403, 'Token exchange is disabled');
      }
      const form = await ctx.body<Record<string, unknown>>();
      requireString(form, 'token');
      const provider = ctx.params.provider.toLowerCase();
      // No OAuth providers are configured in this port (OAUTH_PROVIDERS is empty
      // unless an openid provider is registered by the oauth router).
      return ctx.error(404, OAUTH_NOT_CONFIGURED(provider));
    },
  },
];

function intOrNull(value: unknown): number | null {
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) ? n : null;
}

const OAUTH_COMMA_LIST_FIELDS = new Set(['OAUTH_ALLOWED_DOMAINS', 'OAUTH_ADMIN_ROLES', 'OAUTH_ALLOWED_ROLES']);

function formatOauthFormValue(field: string, value: unknown): unknown {
  if (field === 'OAUTH_BLOCKED_GROUPS' && Array.isArray(value)) {
    return JSON.stringify(value);
  }
  if (OAUTH_COMMA_LIST_FIELDS.has(field) && Array.isArray(value)) {
    return value.map((item) => String(item)).join(',');
  }
  return value;
}

function parseOauthUpdateValue(field: string, value: unknown): unknown {
  if (OAUTH_COMMA_LIST_FIELDS.has(field) && typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if ((field === 'OAUTH_TIMEOUT' || field === 'OAUTH_CLIENT_TIMEOUT') && value === '') {
    return '';
  }
  return value;
}
