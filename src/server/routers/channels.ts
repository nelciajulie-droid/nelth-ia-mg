import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { env, ERROR_MESSAGES, DEFAULT_USER_PERMISSIONS } from '@/lib/constants';
import { configGet } from '@/lib/config';
import { hasPermission, hasAccessGrant, getUserGroupIds } from '@/lib/access-control';
import {
  EM,
  nowNs,
  uuid,
  setAccessGrants,
  getGrantsByResource,
  filterAllowedAccessGrants,
  validateAccessGrants,
  hasPublicWriteAccessGrant,
} from '@/lib/models/workspace';

/**
 * Port of open_webui/routers/channels.py (v0.12.5) — /api/v1/channels/*.
 *
 * Gate (check_channels_access): `channels.enable` (env ENABLE_CHANNELS,
 * default False) → 403 'Channels is disabled'; non-admins without the
 * features.channels permission → 401 ERROR_MESSAGES.UNAUTHORIZED.
 *
 * Deviations (documented):
 *   • Socket events (sio.emit / enter_room / close_room) are no-ops.
 *   • publish_event is not ported (no event bus).
 *   • App invocation routes (/{channel_id}/apps*) and channel webhooks are
 *     not ported.
 *   • Background model-response/notification fan-out on message post is not
 *     ported (no task runtime).
 */

function err(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

function safeJson(s: string | null | undefined): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

type ChannelRow = typeof db.channel extends { findFirst: (...a: any[]) => infer R } ? Awaited<R> : never;

// ---------------------------------------------------------------------------
// Models (models/channels.py + models/messages.py serialization)
// ---------------------------------------------------------------------------

type AccessGrant = {
  id: string;
  resource_type: string;
  resource_id: string;
  principal_type: string;
  principal_id: string;
  permission: string;
  created_at: number;
};

type ChannelModel = {
  id: string;
  user_id: string | null;
  type: string | null;
  name: string | null;
  description: string | null;
  is_private: boolean | null;
  data: Record<string, any> | null;
  meta: Record<string, any> | null;
  access_grants: AccessGrant[];
  created_at: number | null;
  updated_at: number | null;
  updated_by: string | null;
  archived_at: number | null;
  archived_by: string | null;
  deleted_at: number | null;
  deleted_by: string | null;
};

type MessageRow = {
  id: string;
  user_id: string | null;
  app_id: string | null;
  channel_id: string | null;
  reply_to_id: string | null;
  parent_id: string | null;
  is_pinned: boolean;
  pinned_at: number | null;
  pinned_by: string | null;
  content: string | null;
  data: string | null;
  meta: string | null;
  created_at: number | null;
  updated_at: number | null;
};

function channelToModel(row: NonNullable<ChannelRow>, grants: AccessGrant[] = []): ChannelModel {
  return {
    id: row.id,
    user_id: row.user_id,
    type: row.type ?? null,
    name: row.name ?? null,
    description: row.description ?? null,
    is_private: row.is_private ?? null,
    data: safeJson(row.data),
    meta: safeJson(row.meta),
    access_grants: grants,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    updated_by: row.updated_by ?? null,
    archived_at: row.archived_at ?? null,
    archived_by: row.archived_by ?? null,
    deleted_at: row.deleted_at ?? null,
    deleted_by: row.deleted_by ?? null,
  };
}

async function getChannelById(id: string): Promise<ChannelModel | null> {
  const row = await db.channel.findFirst({ where: { id } });
  if (!row) return null;
  const grants = await getGrantsByResource('channel', id);
  return channelToModel(row, grants);
}

async function userGroupMemberIds(groupIds: string[]): Promise<string[]> {
  if (!groupIds.length) return [];
  const memberships = await db.groupMember.findMany({ where: { group_id: { in: groupIds } } });
  return [...new Set(memberships.map((m) => m.user_id))];
}

/** Python Channels._collect_unique_user_ids. */
async function collectUniqueUserIds(
  invitedBy: string,
  userIds: string[] | null | undefined,
  groupIds: string[] | null | undefined
): Promise<Set<string>> {
  const users = new Set<string>((userIds ?? []).map(String));
  users.add(invitedBy);
  for (const gid of groupIds ?? []) {
    for (const uid of await userGroupMemberIds([gid])) users.add(uid);
  }
  return users;
}

/** Python Channels.insert_new_channel. */
async function insertNewChannel(
  form: Record<string, any>,
  userId: string
): Promise<ChannelModel | null> {
  const now = nowNs();
  const type = form.type ? String(form.type) : null;
  const id = uuid();
  const name = String(form.name ?? '').toLowerCase();

  await db.channel.create({
    data: {
      id,
      user_id: userId,
      type,
      name,
      description: form.description ?? null,
      is_private: form.is_private ?? null,
      data: form.data ? JSON.stringify(form.data) : null,
      meta: form.meta ? JSON.stringify(form.meta) : null,
      created_at: now,
      updated_at: now,
    },
  });

  if (type === 'group' || type === 'dm') {
    const users = await collectUniqueUserIds(userId, form.user_ids, form.group_ids);
    for (const uid of users) {
      if (!uid) continue;
      await db.channelMember.create({
        data: {
          id: uuid(),
          channel_id: id,
          user_id: uid,
          status: 'joined',
          is_active: true,
          is_channel_muted: false,
          is_channel_pinned: false,
          invited_at: now,
          invited_by: userId,
          joined_at: now,
          last_read_at: now,
          created_at: now,
          updated_at: now,
        },
      });
    }
  }

  await setAccessGrants('channel', id, form.access_grants ?? []);
  return getChannelById(id);
}

/** Python Channels.get_channels_by_user_id. */
async function getChannelsByUserId(userId: string): Promise<ChannelModel[]> {
  const userGroupIds = await getUserGroupIds(userId);

  const membershipRows = await db.channel.findMany({
    where: {
      deleted_at: null,
      archived_at: null,
      type: { in: ['group', 'dm'] },
      AND: {
        channelMembers: {
          some: { user_id: userId, is_active: true },
        },
      },
    },
  } as any);

  // standard channels: type null/''/other, visible through access grants
  const standardRows = await db.channel.findMany({
    where: {
      deleted_at: null,
      archived_at: null,
      NOT: { type: { in: ['group', 'dm'] } },
    },
  });

  const rows = [...membershipRows, ...standardRows];
  const grantsMap = await db.accessGrant.findMany({
    where: { resource_type: 'channel', resource_id: { in: rows.map((r) => r.id) } },
  });
  const grantsByChannel = new Map<string, AccessGrant[]>();
  for (const g of grantsMap) {
    const list = grantsByChannel.get(g.resource_id) ?? [];
    list.push(g as AccessGrant);
    grantsByChannel.set(g.resource_id, list);
  }

  const out: ChannelModel[] = [];
  for (const row of rows) {
    if (membershipRows.some((m) => m.id === row.id)) {
      out.push(channelToModel(row, grantsByChannel.get(row.id) ?? []));
      continue;
    }
    const grants = grantsByChannel.get(row.id) ?? [];
    const allowed = grants.some(
      (g) =>
        g.permission === 'read' &&
        ((g.principal_type === 'user' && (g.principal_id === '*' || g.principal_id === userId)) ||
          (g.principal_type === 'group' && userGroupIds.includes(g.principal_id)))
    );
    if (allowed) out.push(channelToModel(row, grants));
  }
  return out;
}

async function getChannels(): Promise<ChannelModel[]> {
  const rows = await db.channel.findMany();
  const out: ChannelModel[] = [];
  for (const row of rows) out.push(channelToModel(row, await getGrantsByResource('channel', row.id)));
  return out;
}

/** Python Channels.get_dm_channel_by_user_ids — exact member-set match. */
async function getDmChannelByUserIds(userIds: string[]): Promise<ChannelModel | null> {
  const unique = [...new Set(userIds)];
  const dmChannels = await db.channel.findMany({ where: { type: 'dm' } });
  for (const channel of dmChannels) {
    const members = await db.channelMember.findMany({ where: { channel_id: channel.id } });
    const memberIds = members.map((m) => m.user_id ?? '').filter(Boolean);
    if (
      memberIds.length === unique.length &&
      unique.every((uid) => memberIds.includes(uid))
    ) {
      return getChannelById(channel.id);
    }
  }
  return null;
}

async function isUserChannelMember(channelId: string, userId: string): Promise<boolean> {
  const member = await db.channelMember.findFirst({
    where: { channel_id: channelId, user_id: userId, is_active: true },
  });
  return member !== null;
}

async function isUserChannelManager(channelId: string, userId: string): Promise<boolean> {
  const channel = await db.channel.findFirst({ where: { id: channelId } });
  if (channel && channel.user_id === userId) return true;
  const member = await db.channelMember.findFirst({
    where: { channel_id: channelId, user_id: userId, is_active: true, role: 'manager' },
  });
  return member !== null;
}

/** Python Channels.join_channel — get-or-create membership. */
async function joinChannel(channelId: string, userId: string): Promise<any | null> {
  const existing = await db.channelMember.findFirst({ where: { channel_id: channelId, user_id: userId } });
  if (existing) return existing;
  const now = nowNs();
  return db.channelMember.create({
    data: {
      id: uuid(),
      channel_id: channelId,
      user_id: userId,
      status: 'joined',
      is_active: true,
      is_channel_muted: false,
      is_channel_pinned: false,
      joined_at: now,
      left_at: null,
      last_read_at: now,
      created_at: now,
      updated_at: now,
    },
  });
}

// ---------------------------------------------------------------------------
// Access checks
// ---------------------------------------------------------------------------

async function checkChannelsAccess(ctx: Ctx): Promise<void> {
  const enabled = await configGet<boolean>('channels.enable', env.ENABLE_CHANNELS);
  if (!enabled) err(403, EM.FEATURE_DISABLED('Channels'));

  const user = ctx.user!;
  if (user.role !== 'admin') {
    const permissions = await configGet<Record<string, any> | null>(
      'user.permissions',
      DEFAULT_USER_PERMISSIONS as unknown as Record<string, any>
    );
    if (!(await hasPermission(user.id, 'features.channels', permissions))) {
      err(401, ERROR_MESSAGES.UNAUTHORIZED);
    }
  }
}

/** Python channel_has_access. */
async function channelHasAccess(
  userId: string,
  channel: ChannelModel,
  permission: string,
  strict = true
): Promise<boolean> {
  if (await hasAccessGrant(userId, 'channel', channel.id, permission)) return true;
  if (!strict && permission === 'write' && hasPublicWriteAccessGrant(channel.access_grants)) return true;
  return false;
}

/** Read access for group/dm or standard channels (route-level guard). */
async function assertChannelReadAccess(ctx: Ctx, channel: ChannelModel): Promise<void> {
  const user = ctx.user!;
  if (channel.type === 'group' || channel.type === 'dm') {
    if (!(await isUserChannelMember(channel.id, user.id))) err(403, EM.DEFAULT());
  } else if (user.role !== 'admin' && !(await channelHasAccess(user.id, channel, 'read'))) {
    err(403, EM.DEFAULT());
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function messageToJson(row: NonNullable<MessageRow>): Record<string, any> {
  return {
    id: row.id,
    user_id: row.user_id,
    app_id: row.app_id,
    channel_id: row.channel_id,
    reply_to_id: row.reply_to_id,
    parent_id: row.parent_id,
    is_pinned: row.is_pinned,
    pinned_by: row.pinned_by,
    pinned_at: row.pinned_at,
    content: row.content,
    data: safeJson(row.data),
    meta: safeJson(row.meta),
    created_at: row.created_at,
    updated_at: row.updated_at,
    etag: String(row.updated_at),
  };
}

async function getMessageById(id: string): Promise<NonNullable<MessageRow> | null> {
  const row = await db.message.findFirst({ where: { id } });
  return (row as NonNullable<MessageRow>) ?? null;
}

async function userNameResponse(userId: string | null): Promise<Record<string, any> | null> {
  if (!userId) return null;
  const user = await db.user.findFirst({ where: { id: userId } });
  if (!user) return null;
  return { id: user.id, name: user.name, role: user.role ?? 'pending' };
}

/** Resolve app / webhook identities (Python _resolve_user_info). */
async function resolveMessageUser(row: NonNullable<MessageRow>): Promise<Record<string, any> | null> {
  if (row.app_id) {
    const app = await db.app.findFirst({ where: { id: row.app_id } });
    return {
      id: row.app_id,
      name: app ? app.name : 'Removed App',
      role: 'app',
      profile_image_url: app ? safeJson(app.data)?.manifest?.profile_image_url ?? null : null,
    };
  }
  const meta = safeJson(row.meta);
  const webhookInfo = meta?.webhook;
  if (webhookInfo?.id) {
    const webhook = await db.channelWebhook.findFirst({ where: { id: webhookInfo.id } });
    return webhook
      ? { id: webhook.id, name: webhook.name, role: 'webhook' }
      : { id: webhookInfo.id, name: 'Deleted Webhook', role: 'webhook' };
  }
  return userNameResponse(row.user_id);
}

async function getReactionsByMessageIds(ids: string[]): Promise<Map<string, any[]>> {
  const out = new Map<string, any[]>();
  if (!ids.length) return out;
  const reactions = await db.messageReaction.findMany({ where: { message_id: { in: ids } } });
  const users = await db.user.findMany({
    where: { id: { in: reactions.map((r) => r.user_id ?? '').filter(Boolean) } },
  });
  const userById = new Map(users.map((u) => [u.id, u]));
  for (const id of ids) out.set(id, []);
  const grouped = new Map<string, Map<string, any>>();
  for (const reaction of reactions) {
    const mid = reaction.message_id ?? '';
    const byName = grouped.get(mid) ?? new Map<string, any>();
    grouped.set(mid, byName);
    const entry = byName.get(reaction.name ?? '') ?? { name: reaction.name, users: [], count: 0 };
    const user = reaction.user_id ? userById.get(reaction.user_id) : null;
    if (user) entry.users.push({ id: user.id, name: user.name });
    entry.count += 1;
    byName.set(reaction.name ?? '', entry);
  }
  for (const [mid, byName] of grouped) out.set(mid, [...byName.values()]);
  return out;
}

async function getThreadReplyCounts(ids: string[]): Promise<Map<string, [number, number | null]>> {
  const out = new Map<string, [number, number | null]>();
  if (!ids.length) return out;
  const replies = await db.message.findMany({ where: { parent_id: { in: ids } } });
  for (const reply of replies) {
    const pid = reply.parent_id ?? '';
    const current = out.get(pid) ?? [0, null];
    current[0] += 1;
    const created = reply.created_at ?? null;
    if (created !== null && (current[1] === null || created > current[1])) current[1] = created;
    out.set(pid, current);
  }
  return out;
}

async function getUnreadMessageCount(
  channelId: string,
  userId: string,
  lastReadAt: number | null
): Promise<number> {
  return db.message.count({
    where: {
      channel_id: channelId,
      parent_id: null,
      created_at: { gt: lastReadAt ?? 0 },
      OR: [{ user_id: { not: userId } }, { user_id: null }],
    },
  });
}

/** Python Messages.insert_new_message. */
async function insertNewMessage(
  form: Record<string, any>,
  channelId: string,
  userId: string
): Promise<Record<string, any> | null> {
  await joinChannel(channelId, userId);
  const id = uuid();
  const ts = nowNs();
  await db.message.create({
    data: {
      id,
      user_id: userId,
      channel_id: channelId,
      reply_to_id: form.reply_to_id ?? null,
      parent_id: form.parent_id ?? null,
      is_pinned: false,
      pinned_at: null,
      pinned_by: null,
      content: form.content,
      data: form.data ? JSON.stringify(form.data) : null,
      meta: form.meta ? JSON.stringify(form.meta) : null,
      created_at: ts,
      updated_at: ts,
    },
  });
  const row = await getMessageById(id);
  return row ? messageToJson(row) : null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // ------------------- GET / (user's channels) -------------------
  {
    method: 'GET',
    path: '',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      const channels = await getChannelsByUserId(user.id);

      const channelList: Array<Record<string, any>> = [];
      for (const channel of channels) {
        const lastMessage = await db.message.findFirst({
          where: { channel_id: channel.id },
          orderBy: { created_at: 'desc' },
        });
        const member = await db.channelMember.findFirst({
          where: { channel_id: channel.id, user_id: user.id },
        });
        const unreadCount = member
          ? await getUnreadMessageCount(channel.id, user.id, member.last_read_at ?? null)
          : 0;

        let userIds: string[] | null = null;
        let users: any[] | null = null;
        if (channel.type === 'dm') {
          const members = await db.channelMember.findMany({ where: { channel_id: channel.id } });
          const memberUserIds = members.map((m) => m.user_id ?? '').filter(Boolean);
          const rows = memberUserIds.length
            ? await db.user.findMany({ where: { id: { in: memberUserIds } } })
            : [];
          users = rows.map((u) => ({
            id: u.id,
            name: u.name,
            role: u.role ?? 'pending',
            is_active: (u.last_active_at ?? 0) > nowSecMinus(300),
          }));
          userIds = users.map((u) => u.id);
        }

        channelList.push({
          ...channel,
          user_ids: userIds,
          users,
          last_message_at: lastMessage?.created_at ?? null,
          unread_count: unreadCount,
          is_channel_muted: member ? member.is_channel_muted : false,
        });
      }
      return ctx.json(channelList);
    },
  },

  // ------------------- GET /list -------------------
  {
    method: 'GET',
    path: 'list',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      if (user.role === 'admin') return ctx.json(await getChannels());
      return ctx.json(await getChannelsByUserId(user.id));
    },
  },

  // ------------------- GET /users/{user_id} (DM get-or-create) -------------------
  {
    method: 'GET',
    path: 'users/:user_id',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      try {
        const existing = await getDmChannelByUserIds([user.id, ctx.params.user_id]);
        if (existing) {
          await db.channelMember.updateMany({
            where: { channel_id: existing.id, user_id: user.id },
            data: { is_active: true },
          });
          return ctx.json(existing);
        }
        const channel = await insertNewChannel(
          { type: 'dm', name: '', user_ids: [ctx.params.user_id] },
          user.id
        );
        if (!channel) throw new Error('Error creating channel');
        return ctx.json(channel);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, EM.DEFAULT());
      }
    },
  },

  // ------------------- POST /create -------------------
  {
    method: 'POST',
    path: 'create',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      const form = await ctx.body<Record<string, any>>();

      if (!['group', 'dm'].includes(String(form?.type ?? '')) && user.role !== 'admin') {
        err(401, ERROR_MESSAGES.UNAUTHORIZED);
      }

      const permissions = await configGet<Record<string, any> | null>(
        'user.permissions',
        DEFAULT_USER_PERMISSIONS as unknown as Record<string, any>
      );
      const allowedGrants = await filterAllowedAccessGrants(
        permissions,
        user.id,
        user.role,
        form?.access_grants ?? null,
        'channel'
      );

      try {
        if (form?.type === 'dm') {
          const existing = await getDmChannelByUserIds([user.id, ...(form.user_ids ?? [])]);
          if (existing) {
            await db.channelMember.updateMany({
              where: { channel_id: existing.id, user_id: user.id },
              data: { is_active: true },
            });
            return ctx.json(existing);
          }
        }
        const channel = await insertNewChannel({ ...form, access_grants: allowedGrants }, user.id);
        if (!channel) throw new Error('Error creating channel');
        return ctx.json(channel);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, EM.DEFAULT());
      }
    },
  },

  // ------------------- GET /{id} -------------------
  {
    method: 'GET',
    path: ':id',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);

      const member = await db.channelMember.findFirst({
        where: { channel_id: channel.id, user_id: user.id },
      });
      const unreadCount = await getUnreadMessageCount(
        channel.id,
        user.id,
        member?.last_read_at ?? null
      );
      const isManager = await isUserChannelManager(channel.id, user.id);

      if (channel.type === 'group' || channel.type === 'dm') {
        if (!(await isUserChannelMember(channel.id, user.id))) err(403, EM.DEFAULT());
        const members = await db.channelMember.findMany({ where: { channel_id: channel.id } });
        const memberUserIds = members.map((m) => m.user_id ?? '').filter(Boolean);
        const rows = memberUserIds.length
          ? await db.user.findMany({ where: { id: { in: memberUserIds } } })
          : [];
        const users = rows.map((u) => ({
          id: u.id,
          name: u.name,
          role: u.role ?? 'pending',
          is_active: (u.last_active_at ?? 0) > nowSecMinus(300),
        }));
        return ctx.json({
          ...channel,
          user_ids: users.map((u) => u.id),
          users,
          is_manager: isManager,
          write_access: true,
          user_count: users.length,
          last_read_at: member?.last_read_at ?? null,
          is_channel_muted: member ? member.is_channel_muted : false,
          unread_count: unreadCount,
        });
      }

      if (user.role !== 'admin' && !(await channelHasAccess(user.id, channel, 'read'))) {
        err(403, EM.DEFAULT());
      }
      const writeAccess =
        (await channelHasAccess(user.id, channel, 'write', false)) || user.role === 'admin';

      // user_count approximation: users with read grants (or all non-pending).
      const grants = channel.access_grants.filter((g) => g.permission === 'read');
      let userCount: number;
      if (hasPublicReadAccessGrant(grants)) {
        userCount = await db.user.count({ where: { role: { not: 'pending' } } });
      } else {
        const grantUserIds = grants.filter((g) => g.principal_type === 'user').map((g) => g.principal_id);
        const grantGroupIds = grants.filter((g) => g.principal_type === 'group').map((g) => g.principal_id);
        const groupUserIds = await userGroupMemberIds(grantGroupIds);
        const ids = [...new Set([...grantUserIds, ...groupUserIds, channel.user_id ?? ''])].filter(Boolean);
        userCount = ids.length;
      }

      return ctx.json({
        ...channel,
        user_ids: null,
        users: null,
        is_manager: isManager,
        write_access: writeAccess,
        user_count: userCount,
        last_read_at: member?.last_read_at ?? null,
        is_channel_muted: member ? member.is_channel_muted : false,
        unread_count: unreadCount,
      });
    },
  },

  // ------------------- GET /{id}/members -------------------
  {
    method: 'GET',
    path: ':id/members',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);
      await assertChannelReadAccess(ctx, channel);

      const query = ctx.query.get('query') ?? null;
      const orderBy = ctx.query.get('order_by') ?? null;
      const direction = ctx.query.get('direction') ?? null;
      const page = Math.max(parseInt(ctx.query.get('page') ?? '1', 10) || 1, 1);
      const limit = 30;
      const skip = (page - 1) * limit;

      const serialize = (u: any) => ({
        id: u.id,
        email: u.email ?? '',
        name: u.name,
        role: u.role ?? 'pending',
        profile_image_url: u.profile_image_url ?? null,
        presence_state: u.presence_state ?? null,
        status_emoji: u.status_emoji ?? null,
        status_message: u.status_message ?? null,
        status_expires_at: u.status_expires_at ?? null,
        is_active: (u.last_active_at ?? 0) > nowSecMinus(300),
      });

      if (channel.type === 'dm') {
        const members = await db.channelMember.findMany({ where: { channel_id: channel.id } });
        const userIds = members.map((m) => m.user_id ?? '').filter(Boolean);
        const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } } }) : [];
        return ctx.json({ users: users.map(serialize), total: users.length });
      }

      let where: any = {};
      if (channel.type === 'group') {
        const members = await db.channelMember.findMany({
          where: { channel_id: channel.id, is_active: true },
        });
        where = { id: { in: members.map((m) => m.user_id ?? '').filter(Boolean) } };
      } else {
        where = { role: { not: 'pending' } };
        const grants = channel.access_grants.filter((g) => g.permission === 'read');
        if (!hasPublicReadAccessGrant(grants)) {
          const grantUserIds = grants.filter((g) => g.principal_type === 'user').map((g) => g.principal_id);
          const grantGroupIds = grants.filter((g) => g.principal_type === 'group').map((g) => g.principal_id);
          const groupUserIds = await userGroupMemberIds(grantGroupIds);
          where = { role: { not: 'pending' }, id: { in: [...new Set([...grantUserIds, ...groupUserIds, channel.user_id ?? ''])].filter(Boolean) } };
        }
      }
      if (query) {
        where = {
          AND: [where, { OR: [{ name: { contains: query } }, { email: { contains: query } }] }],
        };
      }

      const orderField = orderBy === 'email' ? 'email' : orderBy === 'name' ? 'name' : 'created_at';
      const orderDir = direction === 'asc' ? 'asc' : 'desc';
      const total = await db.user.count({ where });
      const users = await db.user.findMany({
        where,
        orderBy: { [orderField]: orderDir },
        skip,
        take: limit,
      });
      return ctx.json({ users: users.map(serialize), total });
    },
  },

  // ------------------- POST /{id}/members/mute -------------------
  {
    method: 'POST',
    path: ':id/members/mute',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (channel.type === 'group' || channel.type === 'dm') {
        if (!(await isUserChannelMember(channel.id, user.id))) err(403, EM.DEFAULT());
      } else if (user.role !== 'admin' && !(await channelHasAccess(user.id, channel, 'read'))) {
        err(403, EM.DEFAULT());
      }

      const form = await ctx.body<Record<string, any>>();
      const isChannelMuted = Boolean(form?.is_channel_muted);
      await db.channelMember.updateMany({
        where: { channel_id: channel.id, user_id: user.id },
        data: { is_channel_muted: isChannelMuted, updated_at: nowNs() },
      });
      return ctx.json({ is_channel_muted: isChannelMuted });
    },
  },

  // ------------------- POST /{id}/members/active -------------------
  {
    method: 'POST',
    path: ':id/members/active',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (!(await isUserChannelMember(channel.id, user.id))) err(404, ERROR_MESSAGES.NOT_FOUND);

      const form = await ctx.body<Record<string, any>>();
      await db.channelMember.updateMany({
        where: { channel_id: channel.id, user_id: user.id },
        data: { is_active: Boolean(form?.is_active), updated_at: nowNs() },
      });
      return ctx.json(true);
    },
  },

  // ------------------- POST /{id}/update/members/add -------------------
  {
    method: 'POST',
    path: ':id/update/members/add',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (channel.user_id !== user.id && user.role !== 'admin') err(403, EM.DEFAULT());
      if (channel.type === 'dm') err(403, EM.DEFAULT());

      const form = await ctx.body<Record<string, any>>();
      try {
        const requested = await collectUniqueUserIds(
          channel.user_id ?? user.id,
          form?.user_ids ?? [],
          form?.group_ids ?? []
        );
        const existing = await db.channelMember.findMany({ where: { channel_id: channel.id } });
        const existingIds = new Set(existing.map((m) => m.user_id ?? ''));
        const newIds = [...requested].filter((uid) => uid && !existingIds.has(uid));
        if (!newIds.length) return ctx.json([]);

        const now = nowNs();
        const memberships: Array<Record<string, any>> = [];
        for (const uid of newIds) {
          const row = await db.channelMember.create({
            data: {
              id: uuid(),
              channel_id: channel.id,
              user_id: uid,
              status: 'joined',
              is_active: true,
              is_channel_muted: false,
              is_channel_pinned: false,
              invited_at: now,
              invited_by: user.id,
              joined_at: now,
              last_read_at: now,
              created_at: now,
              updated_at: now,
            },
          });
          memberships.push(row);
        }
        return ctx.json(memberships);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, EM.DEFAULT());
      }
    },
  },

  // ------------------- POST /{id}/update/members/remove -------------------
  {
    method: 'POST',
    path: ':id/update/members/remove',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (channel.user_id !== user.id && user.role !== 'admin') err(403, EM.DEFAULT());
      if (channel.type === 'dm') err(403, EM.DEFAULT());

      const form = await ctx.body<Record<string, any>>();
      try {
        const userIds = (form?.user_ids ?? []).map(String);
        const result = await db.channelMember.deleteMany({
          where: { channel_id: channel.id, user_id: { in: userIds } },
        });
        return ctx.json(result.count);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, EM.DEFAULT());
      }
    },
  },

  // ------------------- POST /{id}/update -------------------
  {
    method: 'POST',
    path: ':id/update',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (channel.user_id !== user.id && user.role !== 'admin') err(403, EM.DEFAULT());

      const form = await ctx.body<Record<string, any>>();
      try {
        await db.channel.update({
          where: { id: channel.id },
          data: {
            name: form?.name !== undefined ? String(form.name ?? '') : undefined,
            description: form?.description !== undefined ? (form.description ?? null) : undefined,
            is_private: form?.is_private !== undefined ? (form.is_private ?? null) : undefined,
            data: form?.data !== undefined ? (form.data ? JSON.stringify(form.data) : null) : undefined,
            meta: form?.meta !== undefined ? (form.meta ? JSON.stringify(form.meta) : null) : undefined,
            updated_at: nowNs(),
            updated_by: user.id,
          },
        });
        return ctx.json(await getChannelById(channel.id));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, EM.DEFAULT());
      }
    },
  },

  // ------------------- POST /{id}/access/update -------------------
  {
    method: 'POST',
    path: ':id/access/update',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (channel.user_id !== user.id && user.role !== 'admin') {
        err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }
      if (channel.type === 'group' || channel.type === 'dm') {
        err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const form = await ctx.body<Record<string, any>>();
      const permissions = await configGet<Record<string, any> | null>(
        'user.permissions',
        DEFAULT_USER_PERMISSIONS as unknown as Record<string, any>
      );
      const grants = await validateAccessGrants(
        permissions,
        user.id,
        user.role,
        form?.access_grants ?? [],
        'channel'
      );
      await setAccessGrants('channel', channel.id, grants);
      return ctx.json(await getChannelById(channel.id));
    },
  },

  // ------------------- DELETE /{id}/delete -------------------
  {
    method: 'DELETE',
    path: ':id/delete',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (channel.user_id !== user.id && user.role !== 'admin') err(403, EM.DEFAULT());

      try {
        await db.channelMember.deleteMany({ where: { channel_id: channel.id } });
        await db.message.deleteMany({ where: { channel_id: channel.id } });
        await db.channelFile.deleteMany({ where: { channel_id: channel.id } });
        await db.accessGrant.deleteMany({ where: { resource_type: 'channel', resource_id: channel.id } });
        await db.channel.delete({ where: { id: channel.id } });
        return ctx.json(true);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, EM.DEFAULT());
      }
    },
  },

  // ------------------- GET /{id}/messages -------------------
  {
    method: 'GET',
    path: ':id/messages',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);
      await assertChannelReadAccess(ctx, channel);
      if (channel.type !== 'group' && channel.type !== 'dm') {
        await joinChannel(channel.id, user.id);
      }

      const skip = parseInt(ctx.query.get('skip') ?? '0', 10) || 0;
      const limit = parseInt(ctx.query.get('limit') ?? '50', 10) || 50;

      const rows = await db.message.findMany({
        where: { channel_id: channel.id, parent_id: null },
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      });
      if (!rows.length) return ctx.json([]);

      const reactions = await getReactionsByMessageIds(rows.map((r) => r.id));
      const replyCounts = await getThreadReplyCounts(rows.map((r) => r.id));

      const messages: Array<Record<string, any>> = [];
      for (const row of rows) {
        const [replyCount, latestReplyAt] = replyCounts.get(row.id) ?? [0, null];
        messages.push({
          ...messageToJson(row),
          reply_count: replyCount,
          latest_reply_at: latestReplyAt,
          reactions: reactions.get(row.id) ?? [],
          user: await resolveMessageUser(row),
        });
      }
      return ctx.json(messages);
    },
  },

  // ------------------- GET /{id}/messages/pinned -------------------
  {
    method: 'GET',
    path: ':id/messages/pinned',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);
      await assertChannelReadAccess(ctx, channel);

      const page = Math.max(parseInt(ctx.query.get('page') ?? '1', 10) || 1, 1);
      const skip = (page - 1) * 20;
      const rows = await db.message.findMany({
        where: { channel_id: channel.id, is_pinned: true, parent_id: null },
        orderBy: { created_at: 'desc' },
        skip,
        take: 20,
      });
      if (!rows.length) return ctx.json([]);

      const reactions = await getReactionsByMessageIds(rows.map((r) => r.id));
      const messages: Array<Record<string, any>> = [];
      for (const row of rows) {
        const meta = safeJson(row.meta);
        let userInfo: Record<string, any> | null;
        if (meta?.webhook) {
          userInfo = {
            id: meta.webhook.id ?? '',
            name: meta.webhook.name ?? 'Webhook',
            role: 'webhook',
          };
        } else {
          userInfo = await userNameResponse(row.user_id);
        }
        messages.push({
          ...messageToJson(row),
          reactions: reactions.get(row.id) ?? [],
          user: userInfo,
        });
      }
      return ctx.json(messages);
    },
  },

  // ------------------- POST /{id}/messages/post -------------------
  {
    method: 'POST',
    path: ':id/messages/post',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);

      if (channel.type === 'group' || channel.type === 'dm') {
        if (!(await isUserChannelMember(channel.id, user.id))) err(403, EM.DEFAULT());
      } else if (
        user.role !== 'admin' &&
        !(await channelHasAccess(user.id, channel, 'write', false))
      ) {
        err(403, EM.DEFAULT());
      }

      const form = await ctx.body<Record<string, any>>();
      if (form?.content === undefined || form?.content === null) err(422, 'Field required (content)');

      // Thread parent / reply target must belong to this channel.
      for (const refId of [form?.parent_id, form?.reply_to_id]) {
        if (refId) {
          const ref = await getMessageById(String(refId));
          if (!ref || ref.channel_id !== channel.id) err(400, EM.DEFAULT());
        }
      }

      try {
        const message = await insertNewMessage({ ...form, meta: null }, channel.id, user.id);
        if (!message) throw new Error('Error creating message');

        // Reactivate dormant members (group/dm).
        if (channel.type === 'group' || channel.type === 'dm') {
          const members = await db.channelMember.findMany({ where: { channel_id: channel.id } });
          for (const member of members) {
            if (!member.is_active && member.user_id) {
              await db.channelMember.update({
                where: { id: member.id },
                data: { is_active: true, updated_at: nowNs() },
              });
            }
          }
        }

        // Link uploaded files to the channel message.
        const files = message.data?.files;
        if (Array.isArray(files)) {
          for (const file of files) {
            const fileId = file?.id;
            if (!fileId) continue;
            await db.channelFile.updateMany({
              where: { channel_id: channel.id, file_id: String(fileId) },
              data: { message_id: message.id },
            });
          }
        }

        return ctx.json(message);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, EM.DEFAULT());
      }
    },
  },

  // ------------------- GET /{id}/messages/{message_id} -------------------
  {
    method: 'GET',
    path: ':id/messages/:message_id',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);
      await assertChannelReadAccess(ctx, channel);

      const message = await getMessageById(ctx.params.message_id);
      if (!message) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (message.channel_id !== ctx.params.id) err(400, EM.DEFAULT());

      const reactions = await getReactionsByMessageIds([message.id]);
      const replyCounts = await getThreadReplyCounts([message.id]);
      const [replyCount, latestReplyAt] = replyCounts.get(message.id) ?? [0, null];

      let replyToMessage: Record<string, any> | null = null;
      if (message.reply_to_id) {
        const ref = await getMessageById(message.reply_to_id);
        if (ref) {
          replyToMessage = { ...messageToJson(ref), user: await resolveMessageUser(ref) };
        }
      }

      return ctx.json({
        ...messageToJson(message),
        user: await resolveMessageUser(message),
        reply_to_message: replyToMessage,
        latest_reply_at: latestReplyAt,
        reply_count: replyCount,
        reactions: reactions.get(message.id) ?? [],
      });
    },
  },

  // ------------------- GET /{id}/messages/{message_id}/data -------------------
  {
    method: 'GET',
    path: ':id/messages/:message_id/data',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);
      await assertChannelReadAccess(ctx, channel);

      const message = await getMessageById(ctx.params.message_id);
      if (!message) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (message.channel_id !== ctx.params.id) err(400, EM.DEFAULT());
      return ctx.json(safeJson(message.data));
    },
  },

  // ------------------- POST /{id}/messages/{message_id}/pin -------------------
  {
    method: 'POST',
    path: ':id/messages/:message_id/pin',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (channel.type === 'group' || channel.type === 'dm') {
        if (!(await isUserChannelMember(channel.id, user.id))) err(403, EM.DEFAULT());
      } else if (user.role !== 'admin' && !(await channelHasAccess(user.id, channel, 'write'))) {
        err(403, EM.DEFAULT());
      }

      const message = await getMessageById(ctx.params.message_id);
      if (!message) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (message.channel_id !== ctx.params.id) err(400, EM.DEFAULT());

      const form = await ctx.body<Record<string, any>>();
      try {
        const now = nowNs();
        await db.message.update({
          where: { id: message.id },
          data: {
            is_pinned: Boolean(form?.is_pinned),
            pinned_at: form?.is_pinned ? now : null,
            pinned_by: form?.is_pinned ? user.id : null,
            updated_at: now,
          },
        });
        const updated = await getMessageById(message.id);
        return ctx.json({
          ...messageToJson(updated!),
          user: await resolveMessageUser(updated!),
        });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, EM.DEFAULT());
      }
    },
  },

  // ------------------- GET /{id}/messages/{message_id}/thread -------------------
  {
    method: 'GET',
    path: ':id/messages/:message_id/thread',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);
      await assertChannelReadAccess(ctx, channel);

      const parent = await getMessageById(ctx.params.message_id);
      if (!parent || parent.channel_id !== ctx.params.id) return ctx.json([]);

      const rows = await db.message.findMany({
        where: { parent_id: parent.id },
        orderBy: { created_at: 'desc' },
      });
      const reactions = await getReactionsByMessageIds(rows.map((r) => r.id));
      const messages: Array<Record<string, any>> = [];
      for (const row of rows) {
        messages.push({
          ...messageToJson(row),
          reactions: reactions.get(row.id) ?? [],
          user: await resolveMessageUser(row),
        });
      }
      return ctx.json(messages);
    },
  },

  // ------------------- POST /{id}/messages/{message_id}/update -------------------
  {
    method: 'POST',
    path: ':id/messages/:message_id/update',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);

      const message = await getMessageById(ctx.params.message_id);
      if (!message) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (message.channel_id !== ctx.params.id) err(400, EM.DEFAULT());

      if (channel.type === 'group' || channel.type === 'dm') {
        if (!(await isUserChannelMember(channel.id, user.id))) err(403, EM.DEFAULT());
        if (user.role !== 'admin' && message.user_id !== user.id) err(403, EM.DEFAULT());
      } else {
        if (user.role !== 'admin' && !(await channelHasAccess(user.id, channel, 'write', false))) {
          err(403, EM.DEFAULT());
        }
        if (user.role !== 'admin' && message.user_id !== user.id) err(403, EM.DEFAULT());
      }

      const form = await ctx.body<Record<string, any>>();
      if (form?.content === undefined || form?.content === null) err(422, 'Field required (content)');
      try {
        await db.message.update({
          where: { id: message.id },
          data: {
            content: String(form.content),
            data: form.data !== undefined ? (form.data ? JSON.stringify(form.data) : null) : undefined,
            updated_at: nowNs(),
          },
        });
        const updated = await getMessageById(message.id);
        return ctx.json(messageToJson(updated!));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, EM.DEFAULT());
      }
    },
  },

  // ------------------- POST /{id}/messages/{message_id}/reactions/add -------------------
  {
    method: 'POST',
    path: ':id/messages/:message_id/reactions/add',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (channel.type === 'group' || channel.type === 'dm') {
        if (!(await isUserChannelMember(channel.id, user.id))) err(403, EM.DEFAULT());
      } else if (user.role !== 'admin' && !(await channelHasAccess(user.id, channel, 'write', false))) {
        err(403, EM.DEFAULT());
      }

      const message = await getMessageById(ctx.params.message_id);
      if (!message) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (message.channel_id !== ctx.params.id) err(400, EM.DEFAULT());

      const form = await ctx.body<Record<string, any>>();
      if (!form?.name) err(422, 'Field required (name)');
      try {
        const existing = await db.messageReaction.findFirst({
          where: { message_id: message.id, user_id: user.id, name: String(form.name) },
        });
        if (!existing) {
          await db.messageReaction.create({
            data: {
              id: uuid(),
              user_id: user.id,
              message_id: message.id,
              name: String(form.name),
              created_at: nowNs(),
            },
          });
        }
        return ctx.json(true);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, EM.DEFAULT());
      }
    },
  },

  // ------------------- POST /{id}/messages/{message_id}/reactions/remove -------------------
  {
    method: 'POST',
    path: ':id/messages/:message_id/reactions/remove',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (channel.type === 'group' || channel.type === 'dm') {
        if (!(await isUserChannelMember(channel.id, user.id))) err(403, EM.DEFAULT());
      } else if (user.role !== 'admin' && !(await channelHasAccess(user.id, channel, 'write', false))) {
        err(403, EM.DEFAULT());
      }

      const message = await getMessageById(ctx.params.message_id);
      if (!message) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (message.channel_id !== ctx.params.id) err(400, EM.DEFAULT());

      const form = await ctx.body<Record<string, any>>();
      if (!form?.name) err(422, 'Field required (name)');
      try {
        await db.messageReaction.deleteMany({
          where: { message_id: message.id, user_id: user.id, name: String(form.name) },
        });
        return ctx.json(true);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, EM.DEFAULT());
      }
    },
  },

  // ------------------- DELETE /{id}/messages/{message_id}/delete -------------------
  {
    method: 'DELETE',
    path: ':id/messages/:message_id/delete',
    auth: 'user',
    handler: async (ctx) => {
      await checkChannelsAccess(ctx);
      const user = ctx.user!;
      const channel = await getChannelById(ctx.params.id);
      if (!channel) err(404, ERROR_MESSAGES.NOT_FOUND);

      const message = await getMessageById(ctx.params.message_id);
      if (!message) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (message.channel_id !== ctx.params.id) err(400, EM.DEFAULT());

      if (channel.type === 'group' || channel.type === 'dm') {
        if (!(await isUserChannelMember(channel.id, user.id))) err(403, EM.DEFAULT());
        if (user.role !== 'admin' && message.user_id !== user.id) err(403, EM.DEFAULT());
      } else {
        if (user.role !== 'admin' && !(await channelHasAccess(user.id, channel, 'write', false))) {
          err(403, EM.DEFAULT());
        }
        if (user.role !== 'admin' && message.user_id !== user.id) err(403, EM.DEFAULT());
      }

      try {
        await db.messageReaction.deleteMany({ where: { message_id: message.id } });
        await db.message.deleteMany({ where: { parent_id: message.id } });
        await db.message.delete({ where: { id: message.id } });
        return ctx.json(true);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, EM.DEFAULT());
      }
    },
  },
];

/** Python Users.is_active — active within the last 5 minutes. */
function nowSecMinus(seconds: number): number {
  return Math.floor(Date.now() / 1000) - seconds;
}

/** Python has_public_read_access_grant. */
function hasPublicReadAccessGrant(grants: any[] | null | undefined): boolean {
  return (grants ?? []).some(
    (g) => g.principal_type === 'user' && g.principal_id === '*' && g.permission === 'read'
  );
}
