import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { env, ERROR_MESSAGES, DEFAULT_USER_PERMISSIONS, VERSION } from '@/lib/constants';
import { configGet } from '@/lib/config';
import { hasPermission } from '@/lib/access-control';

/** Local alias so `never`-returning error calls narrow control flow. */
function err(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

/**
 * Port of open_webui/routers/notifications.py (v0.12.5) — /api/v1/notifications/*.
 *
 * Targets are stored in user.settings.notifications (utils/notifications.py port).
 * Gate: `ui.enable_user_webhooks` (env ENABLE_USER_WEBHOOKS, default False) →
 * every endpoint 404 ERROR_MESSAGES.NOT_FOUND when disabled (Python parity).
 */

const envBool = (key: string, def: string) => (process.env[key] ?? def).toLowerCase() === 'true';

// NOTIFICATION_EVENTS (events.py) + labels/descriptions from EventDefinitions.
const NOTIFICATION_EVENTS: Array<{ event: string; label: string; description: string }> = [
  { event: 'chat.finished', label: 'Chat finished', description: 'A chat response finished.' },
  { event: 'chat.failed', label: 'Chat failed', description: 'A chat response failed.' },
  { event: 'channel.message', label: 'Channel message', description: 'A channel message was posted.' },
  { event: 'calendar.alert', label: 'Calendar alert', description: 'A calendar event alert was triggered.' },
  {
    event: 'retrieval.content.process_failed',
    label: 'Retrieval Content process failed',
    description: 'Retrieval content processing failed.',
  },
  { event: 'automation.run_failed', label: 'Automation run failed', description: 'An automation run failed.' },
];

const VALID_EVENTS = new Set(NOTIFICATION_EVENTS.map((e) => e.event));
const VALID_DELIVERY = new Set(['away', 'always']);
const DEFAULT_TARGET_ID = 'webhook';
const LEGACY_EVENTS = ['chat.finished', 'chat.failed'];

type Target = {
  id: string;
  type: string;
  enabled: boolean;
  events: string[];
  delivery: string;
  config: Record<string, any>;
  created_at: number;
  updated_at: number;
};

async function checkNotificationsAccess(ctx: Ctx): Promise<void> {
  const enabled = await configGet<boolean>('ui.enable_user_webhooks', envBool('ENABLE_USER_WEBHOOKS', 'False'));
  if (!enabled) err(404, ERROR_MESSAGES.NOT_FOUND);

  const user = ctx.user!;
  if (user.role !== 'admin') {
    const permissions = await configGet<Record<string, any> | null>(
      'user.permissions',
      DEFAULT_USER_PERMISSIONS as unknown as Record<string, any>
    );
    if (!(await hasPermission(user.id, 'features.webhooks', permissions))) {
      err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
    }
  }
}

function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Python utils/notifications._normalize_target. */
function normalizeTarget(
  target: Record<string, any>,
  existing: Record<string, any> | null = null
): Target {
  const ex = existing ?? {};
  const now = Math.floor(Date.now() / 1000);

  const targetType = String(target.type ?? ex.type ?? 'webhook').trim();
  if (targetType !== 'webhook') throw new Error('Unsupported notification target type');

  const config: Record<string, any> = { ...(ex.config ?? {}) };
  Object.assign(config, target.config ?? {});
  let url = String(config.url ?? '').trim();
  if (!url) throw new Error('Webhook URL is required');
  if (url.includes('...')) {
    url = String(ex.config?.url ?? '').trim();
  }
  if (!isValidHttpUrl(url)) throw new Error('Webhook URL is required');
  config.url = url;

  let targetId = String(target.id ?? ex.id ?? '').trim();
  if (!targetId) {
    try {
      targetId = new URL(url).hostname || 'webhook';
    } catch {
      targetId = 'webhook';
    }
  }
  targetId =
    targetId
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'target';

  let events: unknown = 'events' in target ? target.events : (ex.events ?? []);
  if (events === null || events === undefined) events = [];
  if (!Array.isArray(events)) throw new Error('events must be a list');
  const cleanedEvents: string[] = [];
  for (const raw of events) {
    const event = String(raw);
    if (!VALID_EVENTS.has(event)) throw new Error(`unsupported notification event: ${event}`);
    if (!cleanedEvents.includes(event)) cleanedEvents.push(event);
  }

  const delivery = String(target.delivery ?? ex.delivery ?? 'away').trim();
  if (!VALID_DELIVERY.has(delivery)) throw new Error('Invalid notification delivery mode');

  return {
    id: targetId,
    type: targetType,
    enabled: Boolean(target.enabled ?? ex.enabled ?? true),
    events: cleanedEvents,
    delivery,
    config,
    created_at: Number(ex.created_at ?? now) || now,
    updated_at: now,
  };
}

function publicTarget(target: Target, defaultTargetId: string | null | undefined): Record<string, any> {
  const config = { ...(target.config ?? {}) };
  const url = String(config.url ?? '');
  delete config.url;
  if (url) {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname || '';
      const suffix = path.length > 4 ? path.slice(-4) : path;
      config.url_masked = `${parsed.protocol}//${parsed.hostname}/...${suffix}`;
    } catch {
      config.url_masked = '****';
    }
  } else {
    config.url_masked = '';
  }
  return { ...target, config, is_default: target.id === defaultTargetId };
}

async function loadNotifications(userId: string): Promise<Record<string, any>> {
  const row = await db.user.findFirst({ where: { id: userId } });
  if (!row) throw new Error('User not found');
  const settings = row.settings ? (safeParse(row.settings) ?? {}) : {};
  const notifications: Record<string, any> = { ...((settings.notifications as Record<string, any>) ?? {}) };
  const targets = notifications.targets;
  const legacyUrl = String(
    notifications.webhook_url ?? settings.ui?.notifications?.webhook_url ?? ''
  ).trim();

  if (!Array.isArray(targets) || targets.length === 0) {
    if (legacyUrl && !notifications.legacy_notification_events_migrated) {
      const target = normalizeTarget({
        id: DEFAULT_TARGET_ID,
        type: 'webhook',
        enabled: true,
        events: [...VALID_EVENTS].sort(),
        delivery: 'away',
        config: { url: legacyUrl },
      });
      Object.assign(notifications, {
        targets: [target],
        default_target_id: DEFAULT_TARGET_ID,
        legacy_notification_events_migrated: true,
      });
      await saveNotifications(userId, settings, notifications);
    }
  } else {
    notifications.targets = targets.filter((t: unknown) => t && typeof t === 'object');
    if (!notifications.default_target_id) {
      notifications.default_target_id = notifications.targets[0]?.id ?? null;
    }
    if (legacyUrl && !notifications.legacy_notification_events_migrated) {
      let changed = false;
      for (const target of notifications.targets) {
        if (
          target.id === DEFAULT_TARGET_ID &&
          String(target.config?.url ?? '').trim() === legacyUrl &&
          JSON.stringify(target.events ?? []) === JSON.stringify([...LEGACY_EVENTS].sort())
        ) {
          target.events = [...VALID_EVENTS].sort();
          changed = true;
        }
      }
      notifications.legacy_notification_events_migrated = true;
      if (changed) await saveNotifications(userId, settings, notifications);
    }
  }
  return notifications;
}

async function saveNotifications(
  userId: string,
  currentSettings: Record<string, any>,
  notifications: Record<string, any>
): Promise<void> {
  const merged = { ...currentSettings, notifications };
  await db.user.update({ where: { id: userId }, data: { settings: JSON.stringify(merged) } }).catch(() => undefined);
}

function safeParse(s: string): Record<string, any> | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Python utils/webhook.post_webhook (subset: slack/discord/teams/plain JSON). */
async function postWebhook(
  name: string,
  url: string,
  message: string,
  eventData: Record<string, any>,
  description: string | null
): Promise<boolean> {
  const eventText = (message: string, description: string | null): string => {
    const lines = [message];
    if (description && description !== message) lines.push(description);
    const eventName = eventData?.event;
    if (eventName) lines.push(`Event: ${eventName}`);
    return lines.join('\n');
  };

  let payload: Record<string, any>;
  if (url.includes('https://hooks.slack.com') || url.includes('https://chat.googleapis.com')) {
    payload = { text: eventText(message, description) };
  } else if (url.includes('https://discord.com/api/webhooks')) {
    const content = eventText(message, description);
    payload = {
      content: content.length < 2000 ? content : `${content.slice(0, 1980)}... (truncated)`,
    };
  } else if (url.includes('webhook.office.com')) {
    const action = eventData?.action ?? 'undefined';
    const userData = eventData?.user ?? eventData?.actor ?? {};
    const userDict = typeof userData === 'object' && userData !== null ? userData : {};
    const facts = Object.entries(userDict).map(([name, value]) => ({ name, value: String(value) }));
    if (eventData?.event) facts.unshift({ name: 'event', value: String(eventData.event) });
    if (description) facts.unshift({ name: 'description', value: description });
    payload = {
      '@type': 'MessageCard',
      '@context': 'http://schema.org/extensions',
      themeColor: '0076D7',
      summary: message,
      sections: [
        {
          activityTitle: message,
          activitySubtitle: `${name} (${VERSION}) - ${action}`,
          text: description ?? null,
          facts,
          markdown: true,
        },
      ],
    };
  } else {
    // Generic webhook (Open WebUI default payload shape)
    payload = { message, description, event_data: eventData, name };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function findTarget(notifications: Record<string, any>, target: string): Record<string, any> | null {
  const targets: Record<string, any>[] = notifications.targets ?? [];
  const targetId = (target ?? '').trim() || String(notifications.default_target_id ?? '');
  if (!targetId) return null;
  return targets.find((item) => String(item.id ?? '').toLowerCase() === targetId.toLowerCase()) ?? null;
}

async function sendWebhook(
  target: Record<string, any>,
  message: string,
  data: Record<string, any>,
  title: string,
  description: string | null
): Promise<void> {
  const url = String(target.config?.url ?? '').trim();
  if (!url) throw new Error('Webhook URL is required');
  const ok = await postWebhook('Nelth-AI', url, title || message, data, description);
  if (!ok) throw new Error('Webhook delivery failed');
}

export const routes: Route[] = [
  // ------------------- GET /events -------------------
  {
    method: 'GET',
    path: 'events',
    auth: 'user',
    handler: async (ctx) => {
      await checkNotificationsAccess(ctx);
      return ctx.json({
        events: NOTIFICATION_EVENTS.map(({ event, label, description }) => ({
          event,
          label,
          description,
        })),
      });
    },
  },

  // ------------------- GET /targets -------------------
  {
    method: 'GET',
    path: 'targets',
    auth: 'user',
    handler: async (ctx) => {
      await checkNotificationsAccess(ctx);
      const notifications = await loadNotifications(ctx.user!.id);
      const defaultTargetId = notifications.default_target_id;
      return ctx.json({
        targets: (notifications.targets ?? []).map((t: Target) => publicTarget(t, defaultTargetId)),
      });
    },
  },

  // ------------------- POST /targets -------------------
  {
    method: 'POST',
    path: 'targets',
    auth: 'user',
    handler: async (ctx) => {
      await checkNotificationsAccess(ctx);
      const user = ctx.user!;
      try {
        const payload = await ctx.body<Record<string, any>>();
        const notifications = await loadNotifications(user.id);
        const targets: Record<string, any>[] = notifications.targets ?? [];
        const hasExplicitId = Boolean(String(payload?.id ?? '').trim());
        const target = normalizeTarget(payload ?? {}) as unknown as Record<string, any>;
        if (targets.some((existing) => String(existing.id ?? '').toLowerCase() === target.id.toLowerCase())) {
          if (hasExplicitId) err(400, 'notification target id already exists');
          const base = target.id;
          let suffix = 2;
          while (targets.some((existing) => String(existing.id ?? '').toLowerCase() === target.id.toLowerCase())) {
            target.id = `${base}-${suffix}`;
            suffix += 1;
          }
        }
        targets.push(target);
        notifications.targets = targets;
        if (!notifications.default_target_id) notifications.default_target_id = target.id;
        const row = await db.user.findFirst({ where: { id: user.id } });
        await saveNotifications(user.id, safeParse(row?.settings ?? '') ?? {}, notifications);
        return ctx.json(publicTarget(target as unknown as Target, notifications.default_target_id));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, e instanceof Error ? e.message : 'Unsupported notification target type');
      }
    },
  },

  // ------------------- PUT /targets/{target_id} -------------------
  {
    method: 'PUT',
    path: 'targets/:target_id',
    auth: 'user',
    handler: async (ctx) => {
      await checkNotificationsAccess(ctx);
      const user = ctx.user!;
      try {
        const payload = await ctx.body<Record<string, any>>();
        const targetId = ctx.params.target_id;
        const notifications = await loadNotifications(user.id);
        const targets: Record<string, any>[] = notifications.targets ?? [];
        const index = targets.findIndex((t) => String(t.id ?? '').toLowerCase() === targetId.toLowerCase());
        if (index === -1) err(400, 'Notification target not found');
        const updated = normalizeTarget({ id: targetId, ...payload }, targets[index]) as unknown as Record<
          string,
          any
        >;
        if (
          targets.some((t, idx) => idx !== index && String(t.id ?? '').toLowerCase() === updated.id.toLowerCase())
        ) {
          err(400, 'notification target id already exists');
        }
        targets[index] = updated;
        notifications.targets = targets;
        if (String(notifications.default_target_id ?? '').toLowerCase() === targetId.toLowerCase()) {
          notifications.default_target_id = updated.id;
        }
        const row = await db.user.findFirst({ where: { id: user.id } });
        await saveNotifications(user.id, safeParse(row?.settings ?? '') ?? {}, notifications);
        return ctx.json(publicTarget(updated as unknown as Target, notifications.default_target_id));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, e instanceof Error ? e.message : 'Unsupported notification target type');
      }
    },
  },

  // ------------------- DELETE /targets/{target_id} -------------------
  {
    method: 'DELETE',
    path: 'targets/:target_id',
    auth: 'user',
    handler: async (ctx) => {
      await checkNotificationsAccess(ctx);
      const user = ctx.user!;
      const targetId = ctx.params.target_id;
      const notifications = await loadNotifications(user.id);
      const targets: Record<string, any>[] = notifications.targets ?? [];
      const nextTargets = targets.filter((t) => String(t.id ?? '').toLowerCase() !== targetId.toLowerCase());
      if (nextTargets.length === targets.length) {
        err(404, ERROR_MESSAGES.NOT_FOUND);
      }
      notifications.targets = nextTargets;
      if (String(notifications.default_target_id ?? '').toLowerCase() === targetId.toLowerCase()) {
        notifications.default_target_id = nextTargets[0]?.id ?? null;
      }
      const row = await db.user.findFirst({ where: { id: user.id } });
      await saveNotifications(user.id, safeParse(row?.settings ?? '') ?? {}, notifications);
      return ctx.json({ ok: true });
    },
  },

  // ------------------- PUT /targets/{target_id}/default -------------------
  {
    method: 'PUT',
    path: 'targets/:target_id/default',
    auth: 'user',
    handler: async (ctx) => {
      await checkNotificationsAccess(ctx);
      const user = ctx.user!;
      try {
        const targetId = ctx.params.target_id;
        const notifications = await loadNotifications(user.id);
        const target = (notifications.targets ?? []).find(
          (t: Record<string, any>) => String(t.id ?? '').toLowerCase() === targetId.toLowerCase()
        );
        if (!target) err(400, 'Notification target not found');
        notifications.default_target_id = target.id;
        const row = await db.user.findFirst({ where: { id: user.id } });
        await saveNotifications(user.id, safeParse(row?.settings ?? '') ?? {}, notifications);
        return ctx.json(publicTarget(target as unknown as Target, target.id));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, e instanceof Error ? e.message : 'Notification target not found');
      }
    },
  },

  // ------------------- POST /targets/{target_id}/test -------------------
  {
    method: 'POST',
    path: 'targets/:target_id/test',
    auth: 'user',
    handler: async (ctx) => {
      await checkNotificationsAccess(ctx);
      const user = ctx.user!;
      try {
        const notifications = await loadNotifications(user.id);
        const target = findTarget(notifications, ctx.params.target_id);
        if (!target) err(400, 'Notification target not found');
        await sendWebhook(
          target,
          'This is a test notification from Nelth-AI.',
          { action: 'test', user_id: user.id },
          'Test notification',
          'This is a test notification from Nelth-AI.'
        );
        return ctx.json({ ok: true });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, e instanceof Error ? e.message : 'Notification target not found');
      }
    },
  },
];
