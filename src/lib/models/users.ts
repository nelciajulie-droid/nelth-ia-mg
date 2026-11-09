import { db } from '@/lib/db';

/**
 * Port of open_webui/models/users.py (UsersTable + ApiKey table) on Prisma/Postgres.
 *
 * Row → API-shape mappers mirror the Pydantic UserModel / UserResponse models:
 *   • JSON columns (info/variables/settings/oauth/scim) are TEXT → JSON.parse.
 *   • Timestamps are INTEGER epoch seconds.
 *   • `user.variables` is excluded from UserModel.model_dump() (Field exclude=True)
 *     → userModelDump() omits it.
 *   • UserModel._ensure_profile_image defaults profile_image_url to
 *     `/api/v1/users/{id}/profile/image` when null.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UserModel = {
  id: string;
  email: string;
  username: string | null;
  role: string;
  name: string;
  profile_image_url: string | null;
  profile_banner_image_url: string | null;
  bio: string | null;
  gender: string | null;
  date_of_birth: string | null; // 'YYYY-MM-DD'
  timezone: string | null;
  presence_state: string | null;
  status_emoji: string | null;
  status_message: string | null;
  status_expires_at: number | null;
  info: Record<string, any> | null;
  variables: Record<string, any>;
  settings: Record<string, any> | null;
  oauth: Record<string, any> | null;
  scim: Record<string, any> | null;
  last_active_at: number;
  updated_at: number;
  created_at: number;
};

export type UserStatusForm = {
  status_emoji?: string | null;
  status_message?: string | null;
  status_expires_at?: number | null;
};

export type ApiKeyModel = {
  id: string;
  user_id: string;
  key: string;
  data: Record<string, any> | null;
  expires_at: number | null;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
};

export type GroupModelDump = {
  parent_group_id: string | null;
  id: string;
  user_id: string;
  name: string;
  description: string;
  data: Record<string, any> | null;
  meta: Record<string, any> | null;
  permissions: Record<string, any> | null;
  created_at: number;
  updated_at: number;
};

type UserRow = {
  id: string;
  email: string | null;
  username: string | null;
  role: string | null;
  name: string;
  profile_image_url: string | null;
  profile_banner_image_url: string | null;
  bio: string | null;
  gender: string | null;
  date_of_birth: string | null;
  timezone: string | null;
  presence_state: string | null;
  status_emoji: string | null;
  status_message: string | null;
  status_expires_at: number | null;
  info: string | null;
  variables: string | null;
  settings: string | null;
  oauth: string | null;
  scim: string | null;
  last_active_at: number | null;
  updated_at: number | null;
  created_at: number | null;
};

type ApiKeyRow = {
  id: string;
  user_id: string;
  key: string;
  data: string | null;
  expires_at: number | null;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
};

const nowSec = () => Math.floor(Date.now() / 1000);

function safeJson(s: string | null): Record<string, any> | null {
  if (s === null || s === undefined || s === '') return null;
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// validate_image_url port (open_webui/utils/validate.py)
// ---------------------------------------------------------------------------

const PROFILE_IMAGE_ALLOWED_MIME_TYPES = (process.env.PROFILE_IMAGE_ALLOWED_MIME_TYPES || 'image/png,image/jpeg,image/gif,image/webp')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

const PROFILE_IMAGE_MAX_DATA_URI_SIZE = (() => {
  const raw = (process.env.PROFILE_IMAGE_MAX_DATA_URI_SIZE || '').trim();
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
})();

const SAFE_STATIC_PATHS = new Set([
  '/user.png',
  '/favicon.png',
  '/static/favicon.png',
  '/favicon.svg',
  '/static/favicon.svg',
  '/static/favicon-tab.svg',
]);
const USER_PROFILE_IMAGE_RE = /^\/api\/v1\/users\/[^/?#]+\/profile\/image$/;
const SAFE_DATA_URI_RE = new RegExp(
  `^data:image/(?:${PROFILE_IMAGE_ALLOWED_MIME_TYPES.map((t) => t.split('/').pop()!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')});base64,`,
  'i'
);

/** Python: validate_image_url — raises ValueError on invalid URLs. */
export function validateImageUrl(url: unknown): string {
  if (typeof url !== 'string') throw new Error('Invalid image URL.');
  if (!url || SAFE_STATIC_PATHS.has(url) || USER_PROFILE_IMAGE_RE.test(url)) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null as unknown as URL;
  }
  if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    if (!parsed.hostname) throw new Error('Invalid profile image URL: HTTP(S) URLs must include a host.');
    return url;
  }
  if (SAFE_DATA_URI_RE.test(url)) {
    if (PROFILE_IMAGE_MAX_DATA_URI_SIZE && url.length > PROFILE_IMAGE_MAX_DATA_URI_SIZE) {
      throw new Error(`Invalid profile image URL: data URI exceeds the ${PROFILE_IMAGE_MAX_DATA_URI_SIZE}-byte limit.`);
    }
    return url;
  }
  throw new Error(
    'Invalid profile image URL: must be a known internal path, an HTTP(S) URL with a host, or a data:image URI (png/jpeg/gif/webp).'
  );
}

// ---------------------------------------------------------------------------
// Row → model mappers
// ---------------------------------------------------------------------------

const DEFAULT_PROFILE_IMAGE_URL = (user_id: string) => `/api/v1/users/${user_id}/profile/image`;

export function toUserModel(row: UserRow): UserModel {
  return {
    id: row.id,
    email: row.email ?? '',
    username: row.username ?? null,
    role: row.role ?? 'pending',
    name: row.name,
    profile_image_url: row.profile_image_url || DEFAULT_PROFILE_IMAGE_URL(row.id),
    profile_banner_image_url: row.profile_banner_image_url ?? null,
    bio: row.bio ?? null,
    gender: row.gender ?? null,
    date_of_birth: row.date_of_birth ?? null,
    timezone: row.timezone ?? null,
    presence_state: row.presence_state ?? null,
    status_emoji: row.status_emoji ?? null,
    status_message: row.status_message ?? null,
    status_expires_at: row.status_expires_at ?? null,
    info: safeJson(row.info),
    variables: (safeJson(row.variables) as Record<string, any>) ?? {},
    settings: safeJson(row.settings),
    oauth: safeJson(row.oauth),
    scim: safeJson(row.scim),
    last_active_at: row.last_active_at ?? 0,
    updated_at: row.updated_at ?? 0,
    created_at: row.created_at ?? 0,
  };
}

/** UserModel.model_dump() — `variables` is excluded (Field exclude=True). */
export function userModelDump(user: UserModel): Record<string, unknown> {
  const { variables: _variables, ...rest } = user;
  return rest;
}

function toApiKeyModel(row: ApiKeyRow): ApiKeyModel {
  return {
    id: row.id,
    user_id: row.user_id,
    key: row.key,
    data: safeJson(row.data),
    expires_at: row.expires_at ?? null,
    last_used_at: row.last_used_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Groups helpers (used by the users router; port of
// Groups.get_groups_by_member_ids + user_group_memberships)
// ---------------------------------------------------------------------------

function toGroupModelDump(row: {
  id: string;
  parent_group_id: string | null;
  user_id: string | null;
  name: string | null;
  description: string | null;
  data: string | null;
  meta: string | null;
  permissions: string | null;
  created_at: number | null;
  updated_at: number | null;
}): GroupModelDump {
  return {
    parent_group_id: row.parent_group_id ?? null,
    id: row.id,
    user_id: row.user_id ?? '',
    name: row.name ?? '',
    description: row.description ?? '',
    data: safeJson(row.data),
    meta: safeJson(row.meta),
    permissions: safeJson(row.permissions),
    created_at: row.created_at ?? 0,
    updated_at: row.updated_at ?? 0,
  };
}

/** Python: user_group_memberships(user_ids, include_inherited) — direct + parent-chain ids. */
async function membershipGroupIds(userIds: string[], includeInherited: boolean): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>(userIds.map((uid) => [uid, new Set<string>()]));
  if (!userIds.length) return result;
  const memberships = await db.groupMember.findMany({ where: { user_id: { in: userIds } } });
  if (!memberships.length) return result;
  // map group id → parent id (only needed when walking the inherited chain)
  const allGroups = await db.group.findMany({ select: { id: true, parent_group_id: true } });
  const parentOf = new Map(allGroups.map((g) => [g.id, g.parent_group_id]));
  for (const m of memberships) {
    const set = result.get(m.user_id);
    if (!set) continue;
    set.add(m.group_id);
    if (!includeInherited) continue;
    // walk the parent chain (cycles terminate via the seen set)
    let gid = parentOf.get(m.group_id) ?? null;
    const seen = new Set<string>([m.group_id]);
    while (gid && !seen.has(gid)) {
      seen.add(gid);
      set.add(gid);
      gid = parentOf.get(gid) ?? null;
    }
  }
  return result;
}

/** Python: Groups.get_groups_by_member_ids — groups per user, ordered by updated_at desc, id. */
export async function getGroupsByMemberIds(
  userIds: string[],
  includeInherited = false
): Promise<Map<string, GroupModelDump[]>> {
  const memberships = await membershipGroupIds(userIds, includeInherited);
  const allGroupIds = new Set<string>();
  for (const set of memberships.values()) for (const gid of set) allGroupIds.add(gid);
  const groups = allGroupIds.size
    ? await db.group.findMany({ where: { id: { in: [...allGroupIds] } } })
    : [];
  groups.sort((a, b) => {
    const ua = a.updated_at ?? 0;
    const ub = b.updated_at ?? 0;
    if (ua !== ub) return ub - ua;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const byId = new Map(groups.map((g) => [g.id, toGroupModelDump(g)]));
  const out = new Map<string, GroupModelDump[]>();
  for (const uid of userIds) {
    const set = memberships.get(uid) ?? new Set<string>();
    out.set(uid, [...set].map((gid) => byId.get(gid)).filter(Boolean) as GroupModelDump[]);
  }
  return out;
}

/** Python: Groups.get_groups_by_member_id — single user. */
export async function getGroupsByMemberId(userId: string, includeInherited = false): Promise<GroupModelDump[]> {
  return (await getGroupsByMemberIds([userId], includeInherited)).get(userId) ?? [];
}

// ---------------------------------------------------------------------------
// UsersTable port
// ---------------------------------------------------------------------------

export type UsersFilter = {
  query?: string | null;
  channel_id?: string | null;
  user_ids?: string[];
  group_ids?: string[];
  roles?: string[];
};

export type UsersSort = {
  order_by?: string | null;
  direction?: string | null;
};

export const Users = {
  async insertNewUser(
    id: string,
    name: string,
    email: string,
    profile_image_url = '/user.png',
    role = 'pending',
    username: string | null = null,
    oauth: Record<string, any> | null = null
  ): Promise<UserModel | null> {
    let imageUrl: string;
    try {
      imageUrl = validateImageUrl(profile_image_url);
    } catch {
      imageUrl = '/user.png';
    }
    const ts = nowSec();
    try {
      await db.user.create({
        data: {
          id,
          email,
          name,
          role,
          username: username ?? null,
          profile_image_url: imageUrl,
          oauth: oauth ? JSON.stringify(oauth) : null,
          last_active_at: ts,
          created_at: ts,
          updated_at: ts,
        },
      });
    } catch {
      return null;
    }
    return toUserModel({
      id,
      email,
      name,
      role,
      username,
      profile_image_url: imageUrl,
      profile_banner_image_url: null,
      bio: null,
      gender: null,
      date_of_birth: null,
      timezone: null,
      presence_state: null,
      status_emoji: null,
      status_message: null,
      status_expires_at: null,
      info: null,
      variables: null,
      settings: null,
      oauth: oauth ? JSON.stringify(oauth) : null,
      scim: null,
      last_active_at: ts,
      updated_at: ts,
      created_at: ts,
    });
  },

  async getUserById(id: string): Promise<UserModel | null> {
    const row = await db.user.findFirst({ where: { id } });
    return row ? toUserModel(row) : null;
  },

  async getUserByApiKey(apiKey: string): Promise<UserModel | null> {
    if (!apiKey) return null;
    const keyRow = await db.apiKey.findFirst({ where: { key: apiKey } });
    if (!keyRow) return null;
    const row = await db.user.findFirst({ where: { id: keyRow.user_id } });
    return row ? toUserModel(row) : null;
  },

  async getUserByEmail(email: string): Promise<UserModel | null> {
    // Python uses func.lower(User.email) == email.lower(); Postgres via raw SQL
    const rows = await db.$queryRawUnsafe<UserRow[]>(
      'SELECT * FROM "user" WHERE lower("email") = lower($1) LIMIT 1',
      email
    );
    return rows.length ? toUserModel(rows[0]) : null;
  },

  async getUserByOauthSub(provider: string, sub: string): Promise<UserModel | null> {
    const rows = await db.user.findMany();
    const subStr = String(sub);
    for (const row of rows) {
      const oauth = safeJson(row.oauth);
      if (!oauth) continue;
      const providerData = oauth[provider];
      if (!providerData || typeof providerData !== 'object') continue;
      const storedSub = providerData.sub;
      // JSON numbers compare loosely with their string form (numeric JSON)
      if (storedSub === subStr || String(storedSub) === subStr) return toUserModel(row);
    }
    return null;
  },

  async getUsers(params: {
    filter?: UsersFilter | null;
    sort?: UsersSort | null;
    skip?: number | null;
    limit?: number | null;
  } = {}): Promise<{ users: UserModel[]; total: number }> {
    const filter = params.filter ?? null;
    const sort = params.sort ?? null;
    const where: Record<string, any> = {};

    if (filter) {
      const userIds = filter.user_ids;
      const groupIds = filter.group_ids;
      if (Array.isArray(userIds) && Array.isArray(groupIds)) {
        if (!userIds.length && !groupIds.length) return { users: [], total: 0 };
      }
      if (userIds && userIds.length) where.id = { in: userIds };
      if (filter.roles && filter.roles.length) {
        const includeRoles = filter.roles.filter((r) => !r.startsWith('!'));
        const excludeRoles = filter.roles.filter((r) => r.startsWith('!')).map((r) => r.slice(1));
        const roleWhere: Record<string, any> = {};
        if (includeRoles.length) roleWhere.in = includeRoles;
        if (excludeRoles.length) roleWhere.notIn = excludeRoles;
        if (includeRoles.length || excludeRoles.length) where.role = roleWhere;
      }
    }

    let rows = await db.user.findMany({ where });

    if (filter) {
      if (filter.query) {
        // Python ilike() → case-insensitive contains (LIKE semantics)
        const q = filter.query.toLowerCase();
        rows = rows.filter(
          (r) => (r.name ?? '').toLowerCase().includes(q) || (r.email ?? '').toLowerCase().includes(q)
        );
      }
      if (filter.channel_id) {
        const members = await db.channelMember.findMany({
          where: { channel_id: filter.channel_id },
          select: { user_id: true },
        });
        const ids = new Set(members.map((m) => m.user_id));
        rows = rows.filter((r) => ids.has(r.id));
      }
      if (filter.group_ids && filter.group_ids.length) {
        const memberships = await db.groupMember.findMany({
          where: { group_id: { in: filter.group_ids } },
          select: { user_id: true },
        });
        const ids = new Set(memberships.map((m) => m.user_id));
        rows = rows.filter((r) => ids.has(r.id));
      }
    }

    const order_by = sort?.order_by ?? null;
    const direction = sort?.direction ?? null;

    if (order_by && order_by.startsWith('group_id:')) {
      const groupSortTarget = order_by.split(':', 2)[1];
      const members = await db.groupMember.findMany({
        where: { group_id: groupSortTarget },
        select: { user_id: true },
      });
      const inGroup = new Set(members.map((m) => m.user_id));
      rows.sort((a, b) => {
        const ka = inGroup.has(a.id) ? 1 : 0;
        const kb = inGroup.has(b.id) ? 1 : 0;
        if (ka !== kb) return direction === 'asc' ? ka - kb : kb - ka;
        return (a.name ?? '').localeCompare(b.name ?? '');
      });
    } else if (order_by === 'name') {
      rows.sort((a, b) => (direction === 'asc' ? 1 : -1) * (a.name ?? '').localeCompare(b.name ?? ''));
    } else if (order_by === 'email') {
      rows.sort((a, b) => (direction === 'asc' ? 1 : -1) * (a.email ?? '').localeCompare(b.email ?? ''));
    } else if (order_by === 'created_at') {
      rows.sort((a, b) => (direction === 'asc' ? 1 : -1) * ((a.created_at ?? 0) - (b.created_at ?? 0)));
    } else if (order_by === 'last_active_at') {
      rows.sort((a, b) => (direction === 'asc' ? 1 : -1) * ((a.last_active_at ?? 0) - (b.last_active_at ?? 0)));
    } else if (order_by === 'updated_at') {
      rows.sort((a, b) => (direction === 'asc' ? 1 : -1) * ((a.updated_at ?? 0) - (b.updated_at ?? 0)));
    } else if (order_by === 'role') {
      rows.sort((a, b) => (direction === 'asc' ? 1 : -1) * (a.role ?? '').localeCompare(b.role ?? ''));
    } else if (!filter) {
      rows.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    }

    const total = rows.length;
    const skip = params.skip ?? null;
    const limit = params.limit ?? null;
    if (skip !== null) rows = rows.slice(skip);
    if (limit !== null) rows = rows.slice(0, limit);
    return { users: rows.map(toUserModel), total };
  },

  async getUsersByGroupId(groupId: string): Promise<UserModel[]> {
    const memberships = await db.groupMember.findMany({ where: { group_id: groupId } });
    if (!memberships.length) return [];
    const rows = await db.user.findMany({ where: { id: { in: memberships.map((m) => m.user_id) } } });
    return rows.map(toUserModel);
  },

  async getUsersByUserIds(userIds: string[]): Promise<UserModel[]> {
    if (!userIds.length) return [];
    const rows = await db.user.findMany({ where: { id: { in: userIds } } });
    return rows.map(toUserModel);
  },

  async getNumUsers(): Promise<number> {
    return db.user.count();
  },

  async hasUsers(): Promise<boolean> {
    return (await db.user.count()) > 0;
  },

  /** Earliest-created user; admins win created_at ties. */
  async getFirstUser(): Promise<UserModel | null> {
    const rows = await db.user.findMany();
    if (!rows.length) return null;
    rows.sort((a, b) => {
      const ca = a.created_at ?? 0;
      const cb = b.created_at ?? 0;
      if (ca !== cb) return ca - cb;
      const ra = a.role === 'admin' ? 0 : 1;
      const rb = b.role === 'admin' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return toUserModel(rows[0]);
  },

  async getNumUsersActiveToday(): Promise<number> {
    const current = nowSec();
    const midnight = current - (current % 86400);
    return db.user.count({ where: { last_active_at: { gt: midnight } } });
  },

  async updateUserRoleById(id: string, role: string): Promise<UserModel | null> {
    const row = await db.user.update({ where: { id }, data: { role } }).catch(() => null);
    return row ? toUserModel(row) : null;
  },

  async updateUserStatusById(id: string, form: UserStatusForm): Promise<UserModel | null> {
    const data: Record<string, unknown> = {};
    if (form.status_emoji !== null && form.status_emoji !== undefined) data.status_emoji = form.status_emoji;
    if (form.status_message !== null && form.status_message !== undefined) data.status_message = form.status_message;
    if (form.status_expires_at !== null && form.status_expires_at !== undefined)
      data.status_expires_at = form.status_expires_at;
    if (!Object.keys(data).length) {
      const existing = await db.user.findFirst({ where: { id } });
      return existing ? toUserModel(existing) : null;
    }
    const row = await db.user.update({ where: { id }, data }).catch(() => null);
    return row ? toUserModel(row) : null;
  },

  async updateUserProfileImageUrlById(id: string, url: string): Promise<UserModel | null> {
    let imageUrl: string;
    try {
      imageUrl = validateImageUrl(url);
    } catch {
      imageUrl = '/user.png';
    }
    const row = await db.user.update({ where: { id }, data: { profile_image_url: imageUrl } }).catch(() => null);
    return row ? toUserModel(row) : null;
  },

  async updateLastActiveById(id: string): Promise<void> {
    await db.user.update({ where: { id }, data: { last_active_at: nowSec() } }).catch(() => undefined);
  },

  async updateUserOauthById(id: string, provider: string, sub: string): Promise<UserModel | null> {
    const row = await db.user.findFirst({ where: { id } });
    if (!row) return null;
    const oauth = safeJson(row.oauth) ?? {};
    const providerOauth = { ...(oauth[provider] ?? {}) };
    providerOauth.sub = String(sub);
    oauth[provider] = providerOauth;
    const updated = await db.user
      .update({ where: { id }, data: { oauth: JSON.stringify(oauth) } })
      .catch(() => null);
    return updated ? toUserModel(updated) : null;
  },

  async updateUserScimById(
    id: string,
    provider: string,
    externalId: string | null
  ): Promise<UserModel | null> {
    const row = await db.user.findFirst({ where: { id } });
    if (!row) return null;
    const scim = safeJson(row.scim) ?? {};
    scim[provider] = { external_id: externalId };
    const changed = JSON.stringify(scim) !== row.scim;
    const data: Record<string, unknown> = { scim: JSON.stringify(scim) };
    if (changed) data.updated_at = nowSec();
    const updated = await db.user.update({ where: { id }, data }).catch(() => null);
    return updated ? toUserModel(updated) : null;
  },

  /** Python: Users.update_user_by_id — arbitrary column updates (email propagates to auth). */
  async updateUserById(id: string, updated: Record<string, unknown>): Promise<UserModel | null> {
    const JSON_COLUMNS = ['info', 'variables', 'settings', 'oauth', 'scim'];
    const STRING_COLUMNS = [
      'username',
      'role',
      'name',
      'profile_image_url',
      'profile_banner_image_url',
      'bio',
      'gender',
      'date_of_birth',
      'timezone',
      'presence_state',
      'status_emoji',
      'status_message',
      'email',
    ];
    const INT_COLUMNS = ['status_expires_at', 'last_active_at', 'updated_at', 'created_at'];
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updated)) {
      if (JSON_COLUMNS.includes(key)) {
        data[key] = value === null || value === undefined ? null : JSON.stringify(value);
      } else if (STRING_COLUMNS.includes(key)) {
        data[key] = value === undefined ? null : (value as string);
      } else if (INT_COLUMNS.includes(key)) {
        data[key] = value === null || value === undefined ? null : Number(value);
      }
    }
    if (!Object.keys(data).length) {
      const existing = await db.user.findFirst({ where: { id } });
      return existing ? toUserModel(existing) : null;
    }
    const row = await db.user.update({ where: { id }, data }).catch(() => null);
    if (!row) return null;
    if ('email' in updated) {
      await db.auth
        .update({ where: { id }, data: { email: (updated.email as string) ?? null } })
        .catch(() => undefined);
    }
    return toUserModel(row);
  },

  /** Python: Users.update_user_settings_by_id — merge semantics with ui field-level patching. */
  async updateUserSettingsById(id: string, updated: Record<string, any>): Promise<UserModel | null> {
    const row = await db.user.findFirst({ where: { id } });
    if (!row) return null;
    const userSettings = safeJson(row.settings) ?? {};
    const patch = { ...updated };
    const uiSettings = patch.ui ?? null;
    delete patch.ui;
    Object.assign(userSettings, patch);
    if (uiSettings !== null && uiSettings !== undefined && typeof uiSettings === 'object') {
      const currentUi = { ...((userSettings.ui as Record<string, any>) ?? {}) };
      for (const [key, value] of Object.entries(uiSettings)) {
        if (value === null) delete currentUi[key];
        else currentUi[key] = value;
      }
      userSettings.ui = currentUi;
    }
    const updatedRow = await db.user
      .update({ where: { id }, data: { settings: JSON.stringify(userSettings) } })
      .catch(() => null);
    return updatedRow ? toUserModel(updatedRow) : null;
  },

  /**
   * Python: Users.delete_user_by_id — removes group memberships, chats
   * (incl. shared snapshots + messages) and the user row.
   */
  async deleteUserById(id: string): Promise<boolean> {
    try {
      // remove user from groups (touch updated_at on affected groups)
      const memberships = await db.groupMember.findMany({ where: { user_id: id } });
      if (memberships.length) {
        await db.group
          .updateMany({
            where: { id: { in: memberships.map((m) => m.group_id) } },
            data: { updated_at: nowSec() },
          })
          .catch(() => undefined);
        await db.groupMember.deleteMany({ where: { user_id: id } });
      }
      // delete chats (+ shared snapshots + messages)
      const chats = await db.chat.findMany({ where: { user_id: id }, select: { id: true } });
      const chatIds = chats.map((c) => c.id);
      await db.sharedChat.deleteMany({ where: { user_id: id } });
      if (chatIds.length) {
        await db.automationRun.updateMany({ where: { chat_id: { in: chatIds } }, data: { chat_id: null } });
        await db.chatMessage.deleteMany({ where: { chat_id: { in: chatIds } } });
      }
      await db.chat.deleteMany({ where: { user_id: id } });
      await db.user.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  },

  async getUserApiKeyById(id: string): Promise<string | null> {
    const row = await db.apiKey.findFirst({ where: { user_id: id } });
    return row ? row.key : null;
  },

  async updateUserApiKeyById(id: string, apiKey: string): Promise<boolean> {
    try {
      await db.apiKey.deleteMany({ where: { user_id: id } });
      const ts = nowSec();
      await db.apiKey.create({
        data: { id: `key_${id}`, user_id: id, key: apiKey, created_at: ts, updated_at: ts },
      });
      return true;
    } catch {
      return false;
    }
  },

  async deleteUserApiKeyById(id: string): Promise<boolean> {
    try {
      await db.apiKey.deleteMany({ where: { user_id: id } });
      return true;
    } catch {
      return false;
    }
  },

  async getValidUserIds(userIds: string[]): Promise<string[]> {
    if (!userIds.length) return [];
    const rows = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true } });
    return rows.map((r) => r.id);
  },

  async getSuperAdminUser(): Promise<UserModel | null> {
    const row = await db.user.findFirst({ where: { role: 'admin' } });
    return row ? toUserModel(row) : null;
  },

  async getActiveUserCount(): Promise<number> {
    return db.user.count({ where: { last_active_at: { gte: nowSec() - 180 } } });
  },

  /** Python: Users.is_active — active within the last 3 minutes. */
  isActive(user: UserModel): boolean {
    if (user.last_active_at) return user.last_active_at >= nowSec() - 180;
    return false;
  },

  async isUserActive(userId: string): Promise<boolean> {
    const row = await db.user.findFirst({ where: { id: userId }, select: { last_active_at: true } });
    if (row?.last_active_at) return row.last_active_at >= nowSec() - 180;
    return false;
  },
};

// ---------------------------------------------------------------------------
// api_key table helpers (Python keeps them inside UsersTable; exposed here
// for API-key auth lookups)
// ---------------------------------------------------------------------------

export const ApiKeys = {
  async getApiKeyByKey(key: string): Promise<ApiKeyModel | null> {
    if (!key) return null;
    const row = await db.apiKey.findFirst({ where: { key } });
    return row ? toApiKeyModel(row) : null;
  },

  async getApiKeyByUserId(userId: string): Promise<ApiKeyModel | null> {
    const row = await db.apiKey.findFirst({ where: { user_id: userId } });
    return row ? toApiKeyModel(row) : null;
  },
};
