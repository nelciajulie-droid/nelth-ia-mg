import type { Route } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { configGet } from '@/lib/config';
import { hasPermission } from '@/lib/access-control';
import { DEFAULT_USER_PERMISSIONS } from '@/lib/constants';

/**
 * Port of open_webui/routers/calendar.py (502 lines).
 * Gate: config 'calendar.enable' (env ENABLE_CALENDAR, default True) +
 * per-user 'features.calendar' permission (default False for non-admins)
 * → 403 '401 Unauthorized' (ERROR_MESSAGES.UNAUTHORIZED) exactly like Python.
 * Tables: calendar, calendar_event, calendar_event_attendee (time_ns).
 */

const UNAUTHORIZED = '401 Unauthorized';
const NOT_FOUND = 'We could not find what you were looking for.';

function nowNs(): number {
  return Date.now() * 1e6;
}

function json(s: string | null): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function checkPermission(userId: string, role: string): Promise<void> {
  const enabled = await configGet<boolean>('calendar.enable', true);
  if (!enabled) throw new HttpError(403, UNAUTHORIZED);
  if (role !== 'admin') {
    const perms = await configGet<Record<string, any> | null>('user.permissions', DEFAULT_USER_PERMISSIONS);
    const ok = await hasPermission(userId, 'features.calendar', perms);
    if (!ok) throw new HttpError(403, UNAUTHORIZED);
  }
}

async function calendarResponse(row: any) {
  const grants = await db.accessGrant.findMany({ where: { resource_type: 'calendar', resource_id: row.id } });
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    color: row.color ?? null,
    is_default: row.is_default ?? false,
    is_system: false,
    data: json(row.data),
    meta: json(row.meta),
    access_grants: grants.map((g) => ({
      resource_type: g.resource_type,
      resource_id: g.resource_id,
      principal_type: g.principal_type,
      principal_id: g.principal_id,
      permission: g.permission,
    })),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function eventResponse(row: any) {
  const attendees = await db.calendarEventAttendee.findMany({ where: { event_id: row.id } });
  return {
    id: row.id,
    calendar_id: row.calendar_id,
    user_id: row.user_id,
    title: row.title,
    description: row.description ?? null,
    start_at: row.start_at,
    end_at: row.end_at ?? null,
    all_day: row.all_day ?? false,
    rrule: row.rrule ?? null,
    color: row.color ?? null,
    location: row.location ?? null,
    data: json(row.data),
    meta: json(row.meta),
    is_cancelled: row.is_cancelled ?? false,
    attendees: attendees.map((a) => ({
      event_id: a.event_id,
      user_id: a.user_id,
      status: a.status,
    })),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const routes: Route[] = [
  {
    method: 'GET',
    path: '',
    auth: 'user',
    handler: async (ctx) => {
      await checkPermission(ctx.user!.id, ctx.user!.role);
      const rows = await db.calendar.findMany({
        where: { OR: [{ user_id: ctx.user!.id }, { is_default: true }] },
        orderBy: { created_at: 'asc' },
      });
      return ctx.json(await Promise.all(rows.map(calendarResponse)));
    },
  },
  {
    method: 'POST',
    path: 'create',
    auth: 'user',
    handler: async (ctx) => {
      await checkPermission(ctx.user!.id, ctx.user!.role);
      const form = await ctx.body<any>();
      if (!form?.name) return ctx.error(400, 'Name is required');
      const id = crypto.randomUUID();
      const now = nowNs();
      const row = await db.calendar.create({
        data: {
          id,
          user_id: ctx.user!.id,
          name: form.name,
          color: form.color ?? null,
          is_default: false,
          data: JSON.stringify(form.data ?? {}),
          meta: JSON.stringify(form.meta ?? {}),
          created_at: now,
          updated_at: now,
        },
      });
      return ctx.json(await calendarResponse(row));
    },
  },
  {
    method: 'GET',
    path: 'events',
    auth: 'user',
    handler: async (ctx) => {
      await checkPermission(ctx.user!.id, ctx.user!.role);
      const calendarId = ctx.query.get('calendar_id');
      const start = ctx.query.get('start') ? Number(ctx.query.get('start')) : null;
      const end = ctx.query.get('end') ? Number(ctx.query.get('end')) : null;
      const rows = await db.calendarEvent.findMany({
        where: {
          ...(calendarId ? { calendar_id: calendarId } : {}),
          ...(start !== null ? { start_at: { gte: start } } : {}),
          ...(end !== null ? { end_at: { lte: end } } : {}),
          is_cancelled: false,
        },
        orderBy: { start_at: 'asc' },
      });
      return ctx.json(await Promise.all(rows.map(eventResponse)));
    },
  },
  {
    method: 'POST',
    path: 'events/create',
    auth: 'user',
    handler: async (ctx) => {
      await checkPermission(ctx.user!.id, ctx.user!.role);
      const form = await ctx.body<any>();
      if (!form?.title || form?.start_at === undefined) return ctx.error(400, 'Title and start_at are required');
      const calendarId = form.calendar_id ?? 'default';
      let cal = await db.calendar.findFirst({ where: { OR: [{ id: calendarId }, { user_id: ctx.user!.id, is_default: true }] } });
      if (!cal) {
        const now = nowNs();
        cal = await db.calendar.create({
          data: {
            id: crypto.randomUUID(),
            user_id: ctx.user!.id,
            name: 'Default',
            is_default: true,
            data: '{}',
            meta: '{}',
            created_at: now,
            updated_at: now,
          },
        });
      }
      const now = nowNs();
      const row = await db.calendarEvent.create({
        data: {
          id: crypto.randomUUID(),
          calendar_id: cal.id,
          user_id: ctx.user!.id,
          title: form.title,
          description: form.description ?? null,
          start_at: form.start_at,
          end_at: form.end_at ?? null,
          all_day: form.all_day ?? false,
          rrule: form.rrule ?? null,
          color: form.color ?? null,
          location: form.location ?? null,
          data: JSON.stringify(form.data ?? {}),
          meta: JSON.stringify(form.meta ?? {}),
          created_at: now,
          updated_at: now,
        },
      });
      return ctx.json(await eventResponse(row));
    },
  },
  {
    method: 'GET',
    path: 'events/search',
    auth: 'user',
    handler: async (ctx) => {
      await checkPermission(ctx.user!.id, ctx.user!.role);
      const q = ctx.query.get('q') ?? '';
      const rows = q
        ? await db.calendarEvent.findMany({ where: { title: { contains: q } } })
        : await db.calendarEvent.findMany({ take: 50 });
      return ctx.json(await Promise.all(rows.map(eventResponse)));
    },
  },
  {
    method: 'GET',
    path: 'events/:event_id',
    auth: 'user',
    handler: async (ctx) => {
      await checkPermission(ctx.user!.id, ctx.user!.role);
      const row = await db.calendarEvent.findFirst({ where: { id: ctx.params.event_id } });
      if (!row) return ctx.error(404, NOT_FOUND);
      return ctx.json(await eventResponse(row));
    },
  },
  {
    method: 'POST',
    path: 'events/:event_id/update',
    auth: 'user',
    handler: async (ctx) => {
      await checkPermission(ctx.user!.id, ctx.user!.role);
      const row = await db.calendarEvent.findFirst({ where: { id: ctx.params.event_id } });
      if (!row) return ctx.error(404, NOT_FOUND);
      const form = await ctx.body<any>();
      const updated = await db.calendarEvent.update({
        where: { id: row.id },
        data: {
          ...(form.title !== undefined ? { title: form.title } : {}),
          ...(form.description !== undefined ? { description: form.description } : {}),
          ...(form.start_at !== undefined ? { start_at: form.start_at } : {}),
          ...(form.end_at !== undefined ? { end_at: form.end_at } : {}),
          ...(form.all_day !== undefined ? { all_day: form.all_day } : {}),
          ...(form.rrule !== undefined ? { rrule: form.rrule } : {}),
          ...(form.color !== undefined ? { color: form.color } : {}),
          ...(form.location !== undefined ? { location: form.location } : {}),
          ...(form.is_cancelled !== undefined ? { is_cancelled: form.is_cancelled } : {}),
          updated_at: nowNs(),
        },
      });
      return ctx.json(await eventResponse(updated));
    },
  },
  {
    method: 'DELETE',
    path: 'events/:event_id/delete',
    auth: 'user',
    handler: async (ctx) => {
      await checkPermission(ctx.user!.id, ctx.user!.role);
      const row = await db.calendarEvent.findFirst({ where: { id: ctx.params.event_id } });
      if (!row) return ctx.error(404, NOT_FOUND);
      await db.calendarEventAttendee.deleteMany({ where: { event_id: row.id } });
      await db.calendarEvent.delete({ where: { id: row.id } });
      return ctx.json({ status: true });
    },
  },
  {
    method: 'POST',
    path: 'events/:event_id/rsvp',
    auth: 'user',
    handler: async (ctx) => {
      await checkPermission(ctx.user!.id, ctx.user!.role);
      const row = await db.calendarEvent.findFirst({ where: { id: ctx.params.event_id } });
      if (!row) return ctx.error(404, NOT_FOUND);
      const form = await ctx.body<any>();
      const status = ['accepted', 'declined', 'tentative', 'needs-action'].includes(form?.status)
        ? form.status
        : 'needs-action';
      const existing = await db.calendarEventAttendee.findFirst({
        where: { event_id: row.id, user_id: ctx.user!.id },
      });
      if (existing) {
        await db.calendarEventAttendee.update({
          where: { id: existing.id },
          data: { status, updated_at: nowNs() },
        });
      } else {
        await db.calendarEventAttendee.create({
          data: {
            id: crypto.randomUUID(),
            event_id: row.id,
            user_id: ctx.user!.id,
            status,
            created_at: nowNs(),
            updated_at: nowNs(),
          },
        });
      }
      return ctx.json({ status: true, rsvp: status });
    },
  },
  {
    method: 'GET',
    path: ':calendar_id',
    auth: 'user',
    handler: async (ctx) => {
      await checkPermission(ctx.user!.id, ctx.user!.role);
      const row = await db.calendar.findFirst({ where: { id: ctx.params.calendar_id } });
      if (!row) return ctx.error(404, NOT_FOUND);
      return ctx.json(await calendarResponse(row));
    },
  },
  {
    method: 'POST',
    path: ':calendar_id/update',
    auth: 'user',
    handler: async (ctx) => {
      await checkPermission(ctx.user!.id, ctx.user!.role);
      const row = await db.calendar.findFirst({ where: { id: ctx.params.calendar_id } });
      if (!row) return ctx.error(404, NOT_FOUND);
      const form = await ctx.body<any>();
      const updated = await db.calendar.update({
        where: { id: row.id },
        data: {
          ...(form.name !== undefined ? { name: form.name } : {}),
          ...(form.color !== undefined ? { color: form.color } : {}),
          updated_at: nowNs(),
        },
      });
      return ctx.json(await calendarResponse(updated));
    },
  },
];
