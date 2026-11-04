import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { configGet } from '@/lib/config';
import { ERROR_MESSAGES } from '@/lib/constants';
import { getUserGroupIds, hasPermission } from '@/lib/access-control';
import {
  getPromptById,
  getPromptByCommand,
  getPrompts,
  getPromptTags,
  insertNewPrompt,
  updatePromptById,
  updatePromptMetadata,
  updatePromptVersion,
  togglePromptActive,
  deletePromptById,
  getPromptHistoryByPromptId,
  getPromptHistoryEntryById,
  promptHistoryDiff,
  deletePromptHistoryEntry,
  setAccessGrants,
  validateAccessGrants,
  filterAllowedAccessGrants,
  hasAccessGrant,
  getAccessibleResourceIds,
  toUserResponse,
  getUsersByIds,
  EM,
} from '@/lib/models/workspace';

/**
 * Port of open_webui/routers/prompts.py (/api/v1/prompts).
 * Events (publish_event) are no-ops — no socket runtime.
 */

const BYPASS_ADMIN_ACCESS_CONTROL = (process.env.BYPASS_ADMIN_ACCESS_CONTROL ??
  process.env.ENABLE_ADMIN_WORKSPACE_CONTENT_ACCESS ??
  'True').toLowerCase() === 'true';

const PAGE_ITEM_COUNT = 30;

function err(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

function requireUser(ctx: Ctx) {
  const user = ctx.user;
  if (!user) err(401, ERROR_MESSAGES.NOT_AUTHENTICATED);
  return user;
}

async function canEditPrompts(user: { id: string; role: string }): Promise<boolean> {
  if (user.role === 'admin') return true;
  const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
  return (
    (await hasPermission(user.id, 'workspace.prompts', defaults)) ||
    (await hasPermission(user.id, 'workspace.prompts_import', defaults))
  );
}

export const routes: Route[] = [
  // GET / — all accessible prompts (response_model strips `user`)
  {
    method: 'GET',
    path: '',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const bypass = user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL;
      const prompts = await getPrompts(
        bypass ? {} : { userId: user.id }
      );
      return ctx.json(prompts);
    },
  },

  // GET /tags
  {
    method: 'GET',
    path: 'tags',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const bypass = user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL;
      return ctx.json(await getPromptTags(bypass ? {} : { userId: user.id }));
    },
  },

  // GET /list — filtered + paginated with write_access flags
  {
    method: 'GET',
    path: 'list',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const query = ctx.query.get('query');
      const viewOption = ctx.query.get('view_option');
      const tag = ctx.query.get('tag');
      const orderBy = ctx.query.get('order_by');
      const direction = ctx.query.get('direction');
      const page = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);

      const skip = (page - 1) * PAGE_ITEM_COUNT;
      const userGroupIds = await getUserGroupIds(user.id);
      const bypass = user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL;

      // Base set: accessible prompts (read)
      const prompts = await getPrompts(
        bypass ? {} : { userId: user.id, userGroupIds }
      );

      let rows = prompts;
      if (query) {
        const owners = new Map(
          (await getUsersByIds([...new Set(rows.map((p) => p.user_id))])).map((u) => [u.id, u])
        );
        const q = query.toLowerCase();
        rows = rows.filter((p) => {
          const owner = owners.get(p.user_id);
          return (
            (p.name ?? '').toLowerCase().includes(q) ||
            (p.command ?? '').toLowerCase().includes(q) ||
            (p.content ?? '').toLowerCase().includes(q) ||
            (owner?.name ?? '').toLowerCase().includes(q) ||
            (owner?.email ?? '').toLowerCase().includes(q)
          );
        });
      }
      if (viewOption === 'created') rows = rows.filter((p) => p.user_id === user.id);
      else if (viewOption === 'shared') rows = rows.filter((p) => p.user_id !== user.id);

      if (tag) {
        const lowered = tag.toLowerCase();
        rows = rows.filter((p) => (p.tags ?? []).some((t) => String(t).toLowerCase() === lowered));
      }

      const orderKey = orderBy ?? 'updated_at';
      const dir = direction === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const av = (a as any)[orderKey] ?? '';
        const bv = (b as any)[orderKey] ?? '';
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * dir;
      });

      const total = rows.length;
      const pageItems = rows.slice(skip, skip + PAGE_ITEM_COUNT);

      const writable = bypass
        ? new Set(pageItems.map((p) => p.id as string))
        : await getAccessibleResourceIds(user.id, 'prompt', pageItems.map((p) => p.id as string), 'write', userGroupIds);

      const owners = new Map(
        (await getUsersByIds([...new Set(pageItems.map((p) => p.user_id))])).map((u) => [u.id, u])
      );

      const items = pageItems.map((prompt) => ({
        ...prompt,
        user: toUserResponse(owners.get(prompt.user_id) ?? ({} as any)),
        write_access:
          bypass || user.id === prompt.user_id || writable.has(prompt.id as string),
      }));

      return ctx.json({ items, total });
    },
  },

  // POST /create
  {
    method: 'POST',
    path: 'create',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const form = await ctx.body<{
        command?: string;
        name?: string;
        content?: string;
        data?: Record<string, any> | null;
        meta?: Record<string, any> | null;
        tags?: string[] | null;
        access_grants?: any[] | null;
        commit_message?: string | null;
      }>();

      if (!(await canEditPrompts(user))) {
        err(401, ERROR_MESSAGES.UNAUTHORIZED);
      }

      const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
      const allowedGrants = await filterAllowedAccessGrants(
        defaults,
        user.id,
        user.role,
        form.access_grants ?? null,
        'prompt'
      );

      const existing = await getPromptByCommand(String(form.command ?? ''));
      if (existing !== null) err(400, EM.COMMAND_TAKEN);

      const prompt = await insertNewPrompt(user.id, {
        command: String(form.command ?? ''),
        name: String(form.name ?? ''),
        content: String(form.content ?? ''),
        data: form.data ?? null,
        meta: form.meta ?? null,
        tags: form.tags ?? null,
        access_grants: allowedGrants,
        commit_message: form.commit_message ?? null,
      });
      if (prompt) return ctx.json(prompt);
      err(400, EM.DEFAULT());
    },
  },

  // GET /id/:prompt_id
  {
    method: 'GET',
    path: 'id/:prompt_id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const promptId = ctx.params.prompt_id;
      const prompt = await getPromptById(promptId);
      if (prompt) {
        if (
          user.role === 'admin' ||
          prompt.user_id === user.id ||
          (await hasAccessGrant(user.id, 'prompt', prompt.id as string, 'read'))
        ) {
          const writeAccess =
            (user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL) ||
            user.id === prompt.user_id ||
            (await hasAccessGrant(user.id, 'prompt', prompt.id as string, 'write'));
          return ctx.json({ ...prompt, user: null, write_access: writeAccess });
        }
      }
      err(404, ERROR_MESSAGES.NOT_FOUND);
    },
  },

  // POST /id/:prompt_id/update
  {
    method: 'POST',
    path: 'id/:prompt_id/update',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const promptId = ctx.params.prompt_id;
      const form = await ctx.body<any>();
      const prompt = await getPromptById(promptId);
      if (!prompt) err(404, ERROR_MESSAGES.NOT_FOUND);

      if (
        prompt.user_id !== user.id &&
        !(await hasAccessGrant(user.id, 'prompt', prompt.id as string, 'write')) &&
        user.role !== 'admin'
      ) {
        err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      if (form.command !== prompt.command) {
        const existing = await getPromptByCommand(String(form.command ?? ''));
        if (existing && existing.id !== prompt.id) err(400, EM.COMMAND_TAKEN);
      }

      const updated = await updatePromptById(
        prompt.id as string,
        {
          command: String(form.command ?? ''),
          name: String(form.name ?? ''),
          content: String(form.content ?? ''),
          data: form.data ?? null,
          meta: form.meta ?? null,
          tags: form.tags ?? null,
          is_production: form.is_production ?? true,
          commit_message: form.commit_message ?? null,
        },
        user.id
      );
      if (updated) return ctx.json(updated);
      err(400, EM.DEFAULT());
    },
  },

  // POST /id/:prompt_id/update/meta
  {
    method: 'POST',
    path: 'id/:prompt_id/update/meta',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const promptId = ctx.params.prompt_id;
      const form = await ctx.body<{ name?: string; command?: string; tags?: string[] | null }>();
      const prompt = await getPromptById(promptId);
      if (!prompt) err(404, ERROR_MESSAGES.NOT_FOUND);

      if (
        prompt.user_id !== user.id &&
        !(await hasAccessGrant(user.id, 'prompt', prompt.id as string, 'write')) &&
        user.role !== 'admin'
      ) {
        err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      if (form.command !== prompt.command) {
        const existing = await getPromptByCommand(String(form.command ?? ''));
        if (existing && existing.id !== prompt.id) err(400, EM.COMMAND_TAKEN);
      }

      const updated = await updatePromptMetadata(
        prompt.id as string,
        String(form.name ?? ''),
        String(form.command ?? ''),
        form.tags ?? null
      );
      if (updated) return ctx.json(updated);
      err(400, EM.DEFAULT());
    },
  },

  // POST /id/:prompt_id/update/version
  {
    method: 'POST',
    path: 'id/:prompt_id/update/version',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const promptId = ctx.params.prompt_id;
      const form = await ctx.body<{ version_id?: string }>();
      const prompt = await getPromptById(promptId);
      if (!prompt) err(404, ERROR_MESSAGES.NOT_FOUND);

      if (
        prompt.user_id !== user.id &&
        !(await hasAccessGrant(user.id, 'prompt', prompt.id as string, 'write')) &&
        user.role !== 'admin'
      ) {
        err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const updated = await updatePromptVersion(prompt.id as string, String(form.version_id ?? ''));
      if (updated) return ctx.json(updated);
      err(400, EM.DEFAULT());
    },
  },

  // POST /id/:prompt_id/access/update
  {
    method: 'POST',
    path: 'id/:prompt_id/access/update',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const promptId = ctx.params.prompt_id;
      const form = await ctx.body<{ access_grants?: any[] }>();
      const prompt = await getPromptById(promptId);
      if (!prompt) err(404, ERROR_MESSAGES.NOT_FOUND);

      if (
        prompt.user_id !== user.id &&
        !(await hasAccessGrant(user.id, 'prompt', prompt.id as string, 'write')) &&
        user.role !== 'admin'
      ) {
        err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
      const grants = await validateAccessGrants(defaults, user.id, user.role, form.access_grants ?? [], 'prompt');
      await setAccessGrants('prompt', promptId, grants);

      return ctx.json(await getPromptById(promptId));
    },
  },

  // POST /id/:prompt_id/toggle
  {
    method: 'POST',
    path: 'id/:prompt_id/toggle',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const promptId = ctx.params.prompt_id;
      const prompt = await getPromptById(promptId);
      if (!prompt) err(404, ERROR_MESSAGES.NOT_FOUND);

      if (
        prompt.user_id !== user.id &&
        !(await hasAccessGrant(user.id, 'prompt', prompt.id as string, 'write')) &&
        user.role !== 'admin'
      ) {
        err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const result = await togglePromptActive(prompt.id as string);
      if (result) return ctx.json(result);
      err(400, EM.DEFAULT());
    },
  },

  // DELETE /id/:prompt_id/delete
  {
    method: 'DELETE',
    path: 'id/:prompt_id/delete',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const promptId = ctx.params.prompt_id;
      const prompt = await getPromptById(promptId);
      if (!prompt) err(404, ERROR_MESSAGES.NOT_FOUND);

      if (
        prompt.user_id !== user.id &&
        !(await hasAccessGrant(user.id, 'prompt', prompt.id as string, 'write')) &&
        user.role !== 'admin'
      ) {
        err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const result = await deletePromptById(prompt.id as string);
      return ctx.json(result);
    },
  },

  // GET /id/:prompt_id/history — static segments before :history_id
  {
    method: 'GET',
    path: 'id/:prompt_id/history',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const promptId = ctx.params.prompt_id;
      const page = Number(ctx.query.get('page') ?? 0) || 0;
      const PAGE_SIZE = 20;

      const prompt = await getPromptById(promptId);
      if (!prompt) err(404, ERROR_MESSAGES.NOT_FOUND);

      if (
        !(
          user.role === 'admin' ||
          prompt.user_id === user.id ||
          (await hasAccessGrant(user.id, 'prompt', prompt.id as string, 'read'))
        )
      ) {
        err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      return ctx.json(
        await getPromptHistoryByPromptId(prompt.id as string, PAGE_SIZE, page * PAGE_SIZE)
      );
    },
  },

  // GET /id/:prompt_id/history/diff
  {
    method: 'GET',
    path: 'id/:prompt_id/history/diff',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const promptId = ctx.params.prompt_id;
      const fromId = ctx.query.get('from_id') ?? '';
      const toId = ctx.query.get('to_id') ?? '';

      const prompt = await getPromptById(promptId);
      if (!prompt) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (
        !(
          user.role === 'admin' ||
          prompt.user_id === user.id ||
          (await hasAccessGrant(user.id, 'prompt', prompt.id as string, 'read'))
        )
      ) {
        err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const diff = await promptHistoryDiff(fromId, toId, prompt.id as string);
      if (!diff) err(404, ERROR_MESSAGES.NOT_FOUND);
      return ctx.json(diff);
    },
  },

  // GET /id/:prompt_id/history/:history_id
  {
    method: 'GET',
    path: 'id/:prompt_id/history/:history_id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const promptId = ctx.params.prompt_id;
      const historyId = ctx.params.history_id;

      const prompt = await getPromptById(promptId);
      if (!prompt) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (
        !(
          user.role === 'admin' ||
          prompt.user_id === user.id ||
          (await hasAccessGrant(user.id, 'prompt', prompt.id as string, 'read'))
        )
      ) {
        err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      const entry = await getPromptHistoryEntryById(historyId);
      if (!entry || entry.prompt_id !== prompt.id) err(404, ERROR_MESSAGES.NOT_FOUND);
      return ctx.json(entry);
    },
  },

  // DELETE /id/:prompt_id/history/:history_id
  {
    method: 'DELETE',
    path: 'id/:prompt_id/history/:history_id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const promptId = ctx.params.prompt_id;
      const historyId = ctx.params.history_id;

      const prompt = await getPromptById(promptId);
      if (!prompt) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (
        !(
          user.role === 'admin' ||
          prompt.user_id === user.id ||
          (await hasAccessGrant(user.id, 'prompt', prompt.id as string, 'write'))
        )
      ) {
        err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }

      if (prompt.version_id === historyId) {
        err(400, 'Cannot delete the active production version');
      }

      const success = await deletePromptHistoryEntry(historyId, prompt.id as string);
      if (!success) err(404, ERROR_MESSAGES.NOT_FOUND);
      return ctx.json(success);
    },
  },
];
