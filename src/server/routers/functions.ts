import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { ERROR_MESSAGES } from '@/lib/constants';
import {
  getFunctionById,
  getFunctions,
  getFunctionList,
  insertNewFunction,
  updateFunctionById,
  deleteFunctionById,
  getFunctionValvesById,
  updateFunctionValvesById,
  getUserValvesForFunction,
  updateUserValvesForFunction,
  getFunctionHistoryByFunctionId,
  getFunctionHistoryById,
  deleteFunctionHistoryEntry,
  functionDiff,
  getFunctionTypeFromSource,
  getFunctionToggleFromSource,
  getValvesSchema,
  resolveValvesSchemaOptions,
  extractFrontmatter,
  replaceImports,
  decryptValves,
  safeParse,
  EM,
} from '@/lib/models/workspace';

/**
 * Port of open_webui/routers/functions.py (/api/v1/functions).
 *
 * Deviations (documented):
 *  - Function "modules" are statically parsed from the Python source instead
 *    of importlib exec: type (Pipe/Filter/Action/Event priority), `toggle`
 *    flag, frontmatter manifest and Valves/UserValves schemas are regex-based.
 *  - Valve values are stored as plain JSON (ENABLE_VALVE_ENCRYPTION defaults
 *    to False upstream).
 *  - Event publishing / webhook dispatch (publish_event) is a no-op: there is
 *    no socket runtime in this port.
 */

const ENABLE_FUNCTIONS = (process.env.ENABLE_FUNCTIONS ?? 'True').toLowerCase() === 'true';
const CLIENT_TIMEOUT_MS = Number(process.env.AIOHTTP_CLIENT_TIMEOUT ?? 300) * 1000;

function err(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

function requireUser(ctx: Ctx) {
  const user = ctx.user;
  if (!user) err(401, ERROR_MESSAGES.NOT_AUTHENTICATED);
  return user;
}

function githubUrlToRawUrl(url: string): string {
  const m1 = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.*)/);
  if (m1) {
    const [, org, repo, branch, path] = m1;
    return `https://raw.githubusercontent.com/${org}/${repo}/refs/heads/${branch}/${path.replace(/\/$/, '')}/main.py`;
  }
  const m2 = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.*)/);
  if (m2) {
    const [, org, repo, branch, path] = m2;
    return `https://raw.githubusercontent.com/${org}/${repo}/refs/heads/${branch}/${path}`;
  }
  return url;
}

/** Response shape of FunctionResponse (no content). */
function functionResponse(model: any) {
  return {
    version_id: model.version_id ?? null,
    id: model.id,
    user_id: model.user_id ?? null,
    type: model.type,
    name: model.name,
    meta: model.meta ?? {},
    is_active: model.is_active ?? false,
    is_global: model.is_global ?? false,
    updated_at: model.updated_at,
    created_at: model.created_at,
  };
}

/** Shared update logic (Python _update_function). */
async function updateFunction(
  ctx: Ctx,
  id: string,
  formData: { id?: string; name: string; content: string; meta?: Record<string, any>; commit_message?: string | null },
  user: { id: string; role: string },
  versionId: string | null = null
) {
  void ctx;
  try {
    const content = versionId === null ? replaceImports(formData.content) : formData.content;
    const functionType = getFunctionTypeFromSource(content);
    if (!functionType) throw new Error('No Function class found in the module');
    const frontmatter = extractFrontmatter(content);
    const meta = {
      description: null,
      ...(formData.meta ?? {}),
      manifest: frontmatter,
      toggle: getFunctionToggleFromSource(content),
    };
    const updated = await updateFunctionById(
      id,
      {
        name: formData.name,
        type: functionType,
        content,
        meta,
        commit_message: formData.commit_message ?? null,
      },
      user.id,
      versionId
    );
    if (updated) return updated;
    err(400, EM.DEFAULT('Error updating function'));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    err(400, String((e as Error)?.message ?? e));
  }
}

async function requireFunctionHistoryEntry(id: string, historyId: string) {
  const entry = await getFunctionHistoryById(id, historyId);
  if (!entry) err(404, 'Version not found');
  return entry;
}

export const routes: Route[] = [
  // GET / — FunctionResponse list (content stripped by response_model)
  {
    method: 'GET',
    path: '',
    auth: 'user',
    handler: async (ctx) => {
      void ctx;
      if (!ENABLE_FUNCTIONS) return ctx.json([]);
      const functions = await getFunctions();
      return ctx.json(functions.map(functionResponse));
    },
  },

  // GET /list (admin) — with owner user
  {
    method: 'GET',
    path: 'list',
    auth: 'admin',
    handler: async (ctx) => {
      void ctx;
      if (!ENABLE_FUNCTIONS) return ctx.json([]);
      return ctx.json(await getFunctionList());
    },
  },

  // GET /export (admin)
  {
    method: 'GET',
    path: 'export',
    auth: 'admin',
    handler: async (ctx) => {
      if (!ENABLE_FUNCTIONS) return ctx.json([]);
      const includeValves = (ctx.query.get('include_valves') ?? 'false').toLowerCase() === 'true';
      const functions = await getFunctions({ includeValves });
      if (!includeValves) return ctx.json(functions);
      return ctx.json(
        functions.map((f: any) => ({
          ...functionResponse(f),
          content: f.content,
          valves: f.valves ?? null,
        }))
      );
    },
  },

  // POST /load/url (admin)
  {
    method: 'POST',
    path: 'load/url',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<{ url?: string }>();
      const url = String(form.url ?? '');
      if (!url) err(400, 'Please enter a valid URL');

      const rawUrl = githubUrlToRawUrl(url);
      const urlParts = rawUrl.replace(/\/$/, '').split('/');
      const fileName = urlParts[urlParts.length - 1];
      const functionName =
        fileName.endsWith('.py') && !['main.py', 'index.py', '__init__.py'].some((n) => fileName.startsWith(n))
          ? fileName.slice(0, -3)
          : urlParts.length > 1
            ? urlParts[urlParts.length - 2]
            : 'function';

      try {
        const res = await fetch(rawUrl, {
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
        });
        if (res.status !== 200) err(res.status, 'Failed to fetch the function');
        const data = await res.text();
        if (!data) err(400, 'No data received from the URL');
        return ctx.json({ name: functionName, content: data });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(500, EM.DEFAULT(e, 'Error fetching function'));
      }
    },
  },

  // POST /sync (admin)
  {
    method: 'POST',
    path: 'sync',
    auth: 'admin',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const form = await ctx.body<{ functions?: any[] }>();
      try {
        const incoming = form.functions ?? [];
        const previousIds = new Set((await getFunctions()).map((f: any) => f.id));
        const incomingIds = new Set<string>();
        for (const fn of incoming) {
          const content = replaceImports(String(fn.content ?? ''));
          const functionType = getFunctionTypeFromSource(content);
          if (!functionType) throw new Error('No Function class found in the module');
          incomingIds.add(fn.id);
          const meta = {
            description: null,
            ...(fn.meta ?? {}),
            manifest: extractFrontmatter(content),
            toggle: functionType === 'filter' && getFunctionToggleFromSource(content),
          };
          const existing = await getFunctionById(fn.id);
          if (existing) {
            await updateFunctionById(
              fn.id,
              {
                name: fn.name,
                type: functionType,
                content,
                meta,
                is_active: fn.is_active ?? false,
                is_global: fn.is_global ?? false,
                valves: fn.valves ?? null,
                user_id: user.id,
              },
              user.id
            );
          } else {
            await insertNewFunction(user.id, functionType, {
              id: fn.id,
              name: fn.name,
              content,
              meta,
              commit_message: null,
            });
            if (fn.is_active || fn.is_global || fn.valves) {
              await updateFunctionById(
                fn.id,
                {
                  is_active: fn.is_active ?? false,
                  is_global: fn.is_global ?? false,
                  ...(fn.valves !== undefined && fn.valves !== null ? { valves: fn.valves } : {}),
                },
                user.id
              );
            }
          }
        }
        for (const id of previousIds) {
          if (!incomingIds.has(id)) await deleteFunctionById(id);
        }
        const result = await getFunctions({ includeValves: true });
        return ctx.json(
          result.map((f: any) => ({
            version_id: f.version_id ?? null,
            id: f.id,
            user_id: f.user_id ?? null,
            name: f.name,
            type: f.type,
            content: f.content,
            meta: f.meta ?? {},
            valves: decryptValves(f.valves ?? null) ?? null,
            is_active: f.is_active ?? false,
            is_global: f.is_global ?? false,
            updated_at: f.updated_at,
            created_at: f.created_at,
          }))
        );
      } catch (e) {
        if (e instanceof HttpError) throw e;
        console.error(`Failed to load a function: ${e}`);
        err(400, EM.DEFAULT(e, 'Error loading function'));
      }
    },
  },

  // POST /create (admin)
  {
    method: 'POST',
    path: 'create',
    auth: 'admin',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const form = await ctx.body<{
        id?: string;
        name?: string;
        content?: string;
        meta?: Record<string, any>;
        commit_message?: string | null;
      }>();

      const id = String(form.id ?? '');
      if (!/^[A-Za-z_]\w*$/.test(id)) {
        err(400, 'Only alphanumeric characters and underscores are allowed in the id');
      }
      const functionId = id.toLowerCase();

      const existing = await getFunctionById(functionId);
      if (existing !== null) err(400, EM.ID_TAKEN);

      try {
        const content = replaceImports(String(form.content ?? ''));
        const functionType = getFunctionTypeFromSource(content);
        if (!functionType) throw new Error('No Function class found in the module');
        const meta = {
          description: null,
          ...(form.meta ?? {}),
          manifest: extractFrontmatter(content),
          toggle: functionType === 'filter' && getFunctionToggleFromSource(content),
        };
        const fn = await insertNewFunction(user.id, functionType, {
          id: functionId,
          name: String(form.name ?? ''),
          content,
          meta,
          commit_message: form.commit_message ?? null,
        });
        if (fn) return ctx.json(functionResponse(fn));
        err(400, EM.DEFAULT('Error creating function'));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        console.error(`Failed to create a new function: ${e}`);
        err(400, EM.DEFAULT(e, 'Error creating function'));
      }
    },
  },

  // GET /id/:id (admin)
  {
    method: 'GET',
    path: 'id/:id',
    auth: 'admin',
    handler: async (ctx) => {
      const fn = await getFunctionById(ctx.params.id);
      if (fn) return ctx.json(fn);
      err(401, ERROR_MESSAGES.NOT_FOUND);
    },
  },

  // POST /id/:id/toggle (admin)
  {
    method: 'POST',
    path: 'id/:id/toggle',
    auth: 'admin',
    handler: async (ctx) => {
      const id = ctx.params.id;
      const fn = await getFunctionById(id);
      if (!fn) err(401, ERROR_MESSAGES.NOT_FOUND);
      const updated = await updateFunctionById(id, { is_active: !fn.is_active }, ctx.user!.id);
      if (updated) return ctx.json(updated);
      err(400, EM.DEFAULT('Error updating function'));
    },
  },

  // POST /id/:id/toggle/global (admin)
  {
    method: 'POST',
    path: 'id/:id/toggle/global',
    auth: 'admin',
    handler: async (ctx) => {
      const id = ctx.params.id;
      const fn = await getFunctionById(id);
      if (!fn) err(401, ERROR_MESSAGES.NOT_FOUND);
      const updated = await updateFunctionById(id, { is_global: !fn.is_global }, ctx.user!.id);
      if (updated) return ctx.json(updated);
      err(400, EM.DEFAULT('Error updating function'));
    },
  },

  // POST /id/:id/update (admin)
  {
    method: 'POST',
    path: 'id/:id/update',
    auth: 'admin',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const form = await ctx.body<any>();
      return ctx.json(await updateFunction(ctx, ctx.params.id, form, user));
    },
  },

  // DELETE /id/:id/delete (admin)
  {
    method: 'DELETE',
    path: 'id/:id/delete',
    auth: 'admin',
    handler: async (ctx) => {
      const id = ctx.params.id;
      const result = await deleteFunctionById(id);
      return ctx.json(result);
    },
  },

  // GET /id/:id/valves (admin)
  {
    method: 'GET',
    path: 'id/:id/valves',
    auth: 'admin',
    handler: async (ctx) => {
      const id = ctx.params.id;
      const fn = await getFunctionById(id);
      if (!fn) err(401, ERROR_MESSAGES.NOT_FOUND);
      try {
        return ctx.json(await getFunctionValvesById(id));
      } catch (e) {
        err(400, EM.DEFAULT(e, 'Error getting function valves'));
      }
    },
  },

  // GET /id/:id/valves/spec (admin)
  {
    method: 'GET',
    path: 'id/:id/valves/spec',
    auth: 'admin',
    handler: async (ctx) => {
      const id = ctx.params.id;
      const fn = await getFunctionById(id);
      if (!fn) err(401, ERROR_MESSAGES.NOT_FOUND);
      const schema = getValvesSchema(fn.content ?? '', 'Valves');
      return ctx.json(resolveValvesSchemaOptions(schema));
    },
  },

  // POST /id/:id/valves/update (admin)
  {
    method: 'POST',
    path: 'id/:id/valves/update',
    auth: 'admin',
    handler: async (ctx) => {
      const id = ctx.params.id;
      const fn = await getFunctionById(id);
      if (!fn) err(401, ERROR_MESSAGES.NOT_FOUND);

      const schema = getValvesSchema(fn.content ?? '', 'Valves');
      if (!schema) err(401, ERROR_MESSAGES.NOT_FOUND);

      try {
        const formData = await ctx.body<Record<string, any>>();
        const filtered = Object.fromEntries(Object.entries(formData ?? {}).filter(([, v]) => v !== null));
        const known = new Set([...Object.keys(schema.properties ?? {})]);
        const current = (await getFunctionValvesById(id)) ?? {};
        const valvesDict: Record<string, any> = { ...current };
        for (const [k, v] of Object.entries(filtered)) {
          if (known.has(k)) valvesDict[k] = v;
        }
        await updateFunctionValvesById(id, valvesDict);
        return ctx.json(valvesDict);
      } catch (e) {
        console.error(`Error updating function values by id ${id}: ${e}`);
        err(400, EM.DEFAULT(e, 'Error updating function valves'));
      }
    },
  },

  // GET /id/:id/valves/user (verified user)
  {
    method: 'GET',
    path: 'id/:id/valves/user',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const fn = await getFunctionById(id);
      if (!fn) err(401, ERROR_MESSAGES.NOT_FOUND);
      try {
        return ctx.json(await getUserValvesForFunction(id, user.id));
      } catch (e) {
        err(400, EM.DEFAULT(e, 'Error getting function user valves'));
      }
    },
  },

  // GET /id/:id/valves/user/spec (verified user)
  {
    method: 'GET',
    path: 'id/:id/valves/user/spec',
    auth: 'user',
    handler: async (ctx) => {
      const id = ctx.params.id;
      const fn = await getFunctionById(id);
      if (!fn) err(401, ERROR_MESSAGES.NOT_FOUND);
      if (!fn.is_active) return ctx.json(null);
      const schema = getValvesSchema(fn.content ?? '', 'UserValves');
      return ctx.json(resolveValvesSchemaOptions(schema));
    },
  },

  // POST /id/:id/valves/user/update (verified user)
  {
    method: 'POST',
    path: 'id/:id/valves/user/update',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const fn = await getFunctionById(id);
      if (!fn) err(401, ERROR_MESSAGES.NOT_FOUND);
      if (!fn.is_active) err(400, 'Function is not active');

      const schema = getValvesSchema(fn.content ?? '', 'UserValves');
      if (!schema) err(401, ERROR_MESSAGES.NOT_FOUND);

      try {
        const formData = await ctx.body<Record<string, any>>();
        const filtered = Object.fromEntries(Object.entries(formData ?? {}).filter(([, v]) => v !== null));
        const known = new Set([...Object.keys(schema.properties ?? {})]);
        const current = (await getUserValvesForFunction(id, user.id)) ?? {};
        const userValves: Record<string, any> = { ...current };
        for (const [k, v] of Object.entries(filtered)) {
          if (known.has(k)) userValves[k] = v;
        }
        const saved = await updateUserValvesForFunction(id, user.id, userValves);
        return ctx.json(saved);
      } catch (e) {
        console.error(`Error updating function user valves by id ${id}: ${e}`);
        err(400, EM.DEFAULT(e, 'Error updating function user valves'));
      }
    },
  },

  // GET /id/:id/history (admin) — static paths before :history_id
  {
    method: 'GET',
    path: 'id/:id/history',
    auth: 'admin',
    handler: async (ctx) => {
      const page = Number(ctx.query.get('page') ?? 1) || 1;
      return ctx.json(await getFunctionHistoryByFunctionId(ctx.params.id, page));
    },
  },

  // GET /id/:id/history/diff (admin)
  {
    method: 'GET',
    path: 'id/:id/history/diff',
    auth: 'admin',
    handler: async (ctx) => {
      const id = ctx.params.id;
      const fromId = ctx.query.get('from_id') ?? '';
      const toId = ctx.query.get('to_id') ?? '';
      const before = await requireFunctionHistoryEntry(id, fromId);
      const after = await requireFunctionHistoryEntry(id, toId);
      return ctx.json(functionDiff(before, after));
    },
  },

  // GET /id/:id/history/:history_id (admin)
  {
    method: 'GET',
    path: 'id/:id/history/:history_id',
    auth: 'admin',
    handler: async (ctx) => {
      const id = ctx.params.id;
      return ctx.json(await requireFunctionHistoryEntry(id, ctx.params.history_id));
    },
  },

  // DELETE /id/:id/history/:history_id (admin)
  {
    method: 'DELETE',
    path: 'id/:id/history/:history_id',
    auth: 'admin',
    handler: async (ctx) => {
      const id = ctx.params.id;
      if (!(await deleteFunctionHistoryEntry(id, ctx.params.history_id))) {
        err(404, 'Version not found');
      }
      return ctx.json(true);
    },
  },

  // POST /id/:id/update/version (admin)
  {
    method: 'POST',
    path: 'id/:id/update/version',
    auth: 'admin',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const form = await ctx.body<{ version_id?: string }>();
      const existing = await getFunctionById(id);
      if (!existing) err(404, 'Not found');
      const entry = await requireFunctionHistoryEntry(id, String(form.version_id ?? ''));
      const snapshot = entry.snapshot ?? {};
      const saved = {
        id,
        name: String(snapshot['name'] ?? ''),
        content: String(snapshot['content'] ?? ''),
        meta: snapshot['meta'] ?? {},
      };
      return ctx.json(await updateFunction(ctx, id, saved, user, entry.id));
    },
  },
];

void safeParse;
void db;
