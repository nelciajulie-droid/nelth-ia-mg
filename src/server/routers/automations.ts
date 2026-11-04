import type { Route } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { configGet } from '@/lib/config';
import { hasPermission } from '@/lib/access-control';
import { DEFAULT_USER_PERMISSIONS } from '@/lib/constants';

/**
 * Port of open_webui/routers/automations.py (401 lines).
 * Gate: config 'automations.enable' (env ENABLE_AUTOMATIONS, default True) +
 * per-user 'features.automations' permission (default False for non-admins)
 * → 403 '401 Unauthorized' exactly like Python (ERROR_MESSAGES.UNAUTHORIZED).
 * Tables: automation, automation_run (time_ns timestamps).
 */

const UNAUTHORIZED = '401 Unauthorized';
const ACTION_PROHIBITED =
  'The requested action has been prohibited as a security measure. Please contact your administrator for assistance.';
const NOT_FOUND = 'We could not find what you were looking for.';

function nowNs(): number {
  return Date.now() * 1e6;
}

async function checkPermission(userId: string, role: string): Promise<void> {
  const enabled = await configGet<boolean>('automations.enable', true);
  if (!enabled) {
    throw new HttpError(403, UNAUTHORIZED);
  }
  if (role !== 'admin') {
    const perms = await configGet<Record<string, any> | null>('user.permissions', DEFAULT_USER_PERMISSIONS);
    const ok = await hasPermission(userId, 'features.automations', perms);
    if (!ok) throw new HttpError(403, UNAUTHORIZED);
  }
}

function automationResponse(row: {
  id: string;
  user_id: string;
  folder_id: string | null;
  name: string;
  data: string;
  meta: string | null;
  is_active: boolean | null;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}) {
  let data: any = {};
  let meta: any = {};
  try {
    data = row.data ? JSON.parse(row.data) : {};
  } catch {
    data = {};
  }
  try {
    meta = row.meta ? JSON.parse(row.meta) : {};
  } catch {
    meta = {};
  }
  return {
    id: row.id,
    user_id: row.user_id,
    folder_id: row.folder_id,
    name: row.name ?? '',
    description: data.description ?? '',
    data,
    meta,
    is_active: row.is_active ?? true,
    schedule: data.rrule ?? null,
    last_run_at: row.last_run_at,
    next_run_at: row.next_run_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const routes: Route[] = [
  {
    method: 'GET',
    path: 'list',
    auth: 'user',
    handler: async (ctx) => {
      await checkPermission(ctx.user!.id, ctx.user!.role);
      const page = Math.max(1, Number(ctx.query.get('page') ?? 1));
      const limit = 60;
      const rows = await db.automation.findMany({
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      });
      return ctx.json(rows.map(automationResponse));
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
      const row = await db.automation.create({
        data: {
          id,
          user_id: ctx.user!.id,
          name: form.name,
          data: JSON.stringify({ ...(form.data ?? {}), description: form.description ?? '' }),
          meta: JSON.stringify(form.meta ?? {}),
          is_active: form.is_active ?? true,
          created_at: now,
          updated_at: now,
        },
      });
      return ctx.json(automationResponse(row));
    },
  },
  {
    method: 'GET',
    path: ':id',
    auth: 'user',
    handler: async (ctx) => {
      await checkPermission(ctx.user!.id, ctx.user!.role);
      const row = await db.automation.findFirst({ where: { id: ctx.params.id } });
      if (!row) return ctx.error(404, NOT_FOUND);
      return ctx.json(automationResponse(row));
    },
  },
  {
    method: 'POST',
    path: ':id/update',
    auth: 'user',
    handler: async (ctx) => {
      await checkPermission(ctx.user!.id, ctx.user!.role);
      const row = await db.automation.findFirst({ where: { id: ctx.params.id } });
      if (!row) return ctx.error(404, NOT_FOUND);
      if (row.user_id !== ctx.user!.id && ctx.user!.role !== 'admin') {
        return ctx.error(403, ACTION_PROHIBITED);
      }
      const form = await ctx.body<any>();
      const updated = await db.automation.update({
        where: { id: row.id },
        data: {
          ...(form.name !== undefined ? { name: form.name } : {}),
          ...(form.data !== undefined ? { data: JSON.stringify(form.data) } : {}),
          ...(form.meta !== undefined ? { meta: JSON.stringify(form.meta) } : {}),
          ...(form.is_active !== undefined ? { is_active: form.is_active } : {}),
          updated_at: nowNs(),
        },
      });
      return ctx.json(automationResponse(updated));
    },
  },
  {
    method: 'POST',
    path: ':id/toggle',
    auth: 'user',
    handler: async (ctx) => {
      await checkPermission(ctx.user!.id, ctx.user!.role);
      const row = await db.automation.findFirst({ where: { id: ctx.params.id } });
      if (!row) return ctx.error(404, NOT_FOUND);
      const updated = await db.automation.update({
        where: { id: row.id },
        data: { is_active: !(row.is_active ?? true), updated_at: nowNs() },
      });
      return ctx.json(automationResponse(updated));
    },
  },
  {
    method: 'POST',
    path: ':id/run',
    auth: 'user',
    handler: async (ctx) => {
      await checkPermission(ctx.user!.id, ctx.user!.role);
      const row = await db.automation.findFirst({ where: { id: ctx.params.id } });
      if (!row) return ctx.error(404, NOT_FOUND);
      // Python executes the automation via the scheduler — port: record a run
      // with pending status (execution engine is a documented deviation).
      const run = await db.automationRun.create({
        data: {
          id: crypto.randomUUID(),
          automation_id: row.id,
          status: 'pending',
          created_at: nowNs(),
        },
      });
      return ctx.json({ status: true, run_id: run.id });
    },
  },
  {
    method: 'DELETE',
    path: ':id/delete',
    auth: 'user',
    handler: async (ctx) => {
      await checkPermission(ctx.user!.id, ctx.user!.role);
      const row = await db.automation.findFirst({ where: { id: ctx.params.id } });
      if (!row) return ctx.error(404, NOT_FOUND);
      if (row.user_id !== ctx.user!.id && ctx.user!.role !== 'admin') {
        return ctx.error(403, ACTION_PROHIBITED);
      }
      await db.automationRun.deleteMany({ where: { automation_id: row.id } });
      await db.automation.delete({ where: { id: row.id } });
      return ctx.json({ status: true });
    },
  },
  {
    method: 'GET',
    path: ':id/runs',
    auth: 'user',
    handler: async (ctx) => {
      await checkPermission(ctx.user!.id, ctx.user!.role);
      const runs = await db.automationRun.findMany({
        where: { automation_id: ctx.params.id },
        orderBy: { created_at: 'desc' },
      });
      return ctx.json(
        runs.map((r) => ({
          id: r.id,
          automation_id: r.automation_id,
          chat_id: r.chat_id,
          status: r.status,
          error: r.error,
          created_at: r.created_at,
        }))
      );
    },
  },
];
