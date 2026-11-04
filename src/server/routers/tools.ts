import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { configGet } from '@/lib/config';

import { getUserGroupIds, hasPermission } from '@/lib/access-control';
import {
  getToolById,
  getTools,
  insertNewTool,
  updateToolById,
  deleteToolById,
  getToolValvesById,
  updateToolValvesById,
  getUserValvesForTool,
  updateUserValvesForTool,
  getToolHistoryByToolId,
  getToolHistoryById,
  deleteToolHistoryEntry,
  toolDiff,
  getToolSpecsFromSource,
  getToolMetaFlags,
  getValvesSchema,
  resolveValvesSchemaOptions,
  sourceHasUserValves,
  extractFrontmatter,
  replaceImports,
  setAccessGrants,
  validateAccessGrants,
  filterAllowedAccessGrants,
  hasAccessGrant,
  safeParse,
  nowSec,
  EM,
} from '@/lib/models/workspace';

/**
 * Port of open_webui/routers/tools.py (/api/v1/tools).
 *
 * Deviations (documented):
 *  - Tool "modules" are statically parsed from the Python source (see
 *    lib/models/workspace.ts) instead of importlib exec — specs, valves
 *    schemas, frontmatter and UserValves detection are regex-based.
 *  - MCP tool servers cannot be reached (no MCP client runtime):
 *    GET /id/:id/specs always 404s and MCP server entries report
 *    authenticated: false.
 *  - Valve values are stored as plain JSON (ENABLE_VALVE_ENCRYPTION defaults
 *    to False upstream; Fernet encryption is not reimplemented).
 */

const BYPASS_ADMIN_ACCESS_CONTROL = (process.env.BYPASS_ADMIN_ACCESS_CONTROL ??
  process.env.ENABLE_ADMIN_WORKSPACE_CONTENT_ACCESS ??
  'True').toLowerCase() === 'true';

const ENABLE_TOOLS = (process.env.ENABLE_TOOLS ?? 'True').toLowerCase() === 'true';
const ENABLE_TOOL_SERVERS = (process.env.ENABLE_TOOL_SERVERS ?? 'True').toLowerCase() === 'true';

const CLIENT_TIMEOUT_MS = Number(process.env.AIOHTTP_CLIENT_TIMEOUT ?? 300) * 1000;

function err(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

function requireUser(ctx: Ctx) {
  const user = ctx.user;
  if (!user) err(401, EM.NOT_AUTHENTICATED);
  return user;
}

function isIdentifier(id: string): boolean {
  return /^[A-Za-z_]\w*$/.test(id);
}
void isIdentifier;

// ---------------------------------------------------------------------------
// OpenAPI → tool payload (port of utils/tools.py convert_openapi_to_tool_payload)
// ---------------------------------------------------------------------------

const OPENAPI_HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

function resolveSchema(schema: any, components: Record<string, any>, resolved = new Set<string>()): Record<string, any> {
  if (!schema || typeof schema !== 'object') return {};
  if ('$ref' in schema) {
    const refPath = String(schema['$ref']);
    const schemaName = refPath.split('/').pop() as string;
    if (resolved.has(schemaName)) return {};
    const refParts = refPath.replace(/^#\/?/, '').split('/');
    let node: any = components;
    for (const part of refParts.slice(1)) node = node?.[part] ?? {};
    return resolveSchema(node, components, new Set([...resolved, schemaName]));
  }
  const out: Record<string, any> = structuredClone(schema);
  if (out['properties']) {
    for (const [prop, propSchema] of Object.entries(out['properties'])) {
      out['properties'][prop] = resolveSchema(propSchema, components, resolved);
    }
  }
  if (out['items']) out['items'] = resolveSchema(out['items'], components, resolved);
  for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(out[keyword])) {
      out[keyword] = out[keyword].map((inner: any) => resolveSchema(inner, components, resolved));
    }
  }
  return out;
}

function convertOpenapiToToolPayload(openapiSpec: Record<string, any>): any[] {
  const toolPayload: any[] = [];
  for (const [path, methods] of Object.entries(openapiSpec['paths'] ?? {})) {
    if (!methods || typeof methods !== 'object') continue;
    const pathLevelParams = Array.isArray(methods['parameters']) ? methods['parameters'] : [];
    for (const [method, operation] of Object.entries(methods as Record<string, any>)) {
      if (!OPENAPI_HTTP_METHODS.has(method)) continue;
      if (!operation || typeof operation !== 'object') continue;
      if (operation['operationId']) {
        const tool: any = {
          name: operation['operationId'],
          description: operation['description'] ?? operation['summary'] ?? 'No description available.',
          parameters: { type: 'object', properties: {}, required: [] },
        };
        const merged = new Map<string, any>();
        for (const param of [...pathLevelParams, ...(Array.isArray(operation['parameters']) ? operation['parameters'] : [])]) {
          if (param && typeof param === 'object' && param['name']) {
            merged.set(`${param['name']}\u0000${param['in'] ?? ''}`, param);
          }
        }
        for (const param of merged.values()) {
          const paramName = param['name'];
          if (!paramName) continue;
          const paramSchema = param['schema'] ?? {};
          let description = paramSchema['description'] ?? '';
          if (!description) description = param['description'] ?? '';
          if (Array.isArray(paramSchema['enum'])) {
            description += `. Possible values: ${paramSchema['enum'].map(String).join(', ')}`;
          }
          const paramProperty: Record<string, any> = {
            type: paramSchema['type'] ?? 'string',
            description,
          };
          if (paramSchema['type'] === 'array' && 'items' in paramSchema) {
            paramProperty['items'] = paramSchema['items'];
          }
          for (const [k, v] of Object.entries(paramProperty)) if (v === null) delete paramProperty[k];
          tool['parameters']['properties'][paramName] = paramProperty;
          if (param['required']) tool['parameters']['required'].push(paramName);
        }
        const requestBody = operation['requestBody'];
        if (requestBody && typeof requestBody === 'object') {
          const jsonSchema = requestBody['content']?.['application/json']?.['schema'];
          if (jsonSchema) {
            const resolved = resolveSchema(jsonSchema, openapiSpec['components'] ?? {});
            if (resolved['properties']) {
              Object.assign(tool['parameters']['properties'], resolved['properties']);
              if ('required' in resolved) {
                tool['parameters']['required'] = [...new Set([...tool['parameters']['required'], ...resolved['required']])];
              }
            } else if (resolved['type'] === 'array') {
              tool['parameters'] = resolved;
            }
          }
        }
        toolPayload.push(tool);
      }
    }
  }
  return toolPayload;
}

function getToolServerUrl(url: string | null | undefined, path: string): string {
  if (!url) return path;
  if (/^https?:\/\//i.test(path)) return path;
  const base = url.replace(/\/$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return base + suffix;
}

async function fetchToolServerData(url: string, headers: Record<string, string> | null): Promise<any> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(headers ?? {}) },
    signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(safeParse<any>(text, text)?.detail ?? text);
  }
  return res.json();
}

type ToolServerEntry = {
  idx: number;
  id: string;
  openapi: Record<string, any>;
  info: Record<string, any>;
  specs: any[];
};

/** Port of utils/tools.py get_tool_servers_data (openapi servers only). */
async function getToolServersData(servers: any[]): Promise<ToolServerEntry[]> {
  const results: ToolServerEntry[] = [];
  if (!ENABLE_TOOL_SERVERS) return [];
  for (let idx = 0; idx < servers.length; idx++) {
    const server = servers[idx] ?? {};
    if (!(server['config'] ?? {})['enable'] || (server['type'] ?? 'openapi') !== 'openapi') continue;
    const info = server['info'] ?? {};
    const id = info['id'] ?? String(idx);
    const serverUrl = server['url'];
    const specType = server['spec_type'] ?? 'url';
    let spec: any = null;
    try {
      if (specType === 'url') {
        const openapiPath = server['path'] ?? 'openapi.json';
        const specUrl = getToolServerUrl(serverUrl, openapiPath);
        const token = (server['auth_type'] ?? 'bearer') === 'bearer' ? server['key'] ?? '' : null;
        spec = await fetchToolServerData(
          specUrl,
          token ? { Authorization: `Bearer ${token}` } : null
        );
      } else if (specType === 'json' && server['spec']) {
        spec = safeParse<any>(server['spec'], null);
      }
    } catch (e) {
      console.error(`Failed to connect to ${serverUrl} OpenAPI tool server`, e);
      continue;
    }
    if (!spec || typeof spec !== 'object' || !('paths' in spec)) continue;
    const openapi = { ...spec, info: spec['info'] ?? {} };
    results.push({
      idx,
      id,
      openapi,
      info: openapi['info'] ?? {},
      specs: convertOpenapiToToolPayload(openapi),
    });
  }
  return results;
}

async function getToolServers(): Promise<ToolServerEntry[]> {
  if (!ENABLE_TOOL_SERVERS) return [];
  try {
    const connections = await configGet<any[]>('tool_server.connections', []);
    return await getToolServersData(connections ?? []);
  } catch (e) {
    console.error('Failed to load tool servers, skipping', e);
    return [];
  }
}

function isStringAllowed(value: string, allowedList: string[]): boolean {
  const patterns = allowedList
    .filter((p) => p)
    .map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
  return patterns.length === 0 || patterns.some((re) => re.test(value));
}

/** Python utils/access_control has_connection_access (config-stored grants). */
async function hasConnectionAccess(
  user: { id: string; role: string },
  connection: Record<string, any>,
  userGroupIds: string[]
): Promise<boolean> {
  if (user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL) return true;
  const accessGrants = (connection['config'] ?? {})['access_grants'] ?? [];
  // PUBLIC-APP MODE: a tool server without access restrictions is part of the
  // shared catalog — every member can use it.
  if (!Array.isArray(accessGrants) || !accessGrants.length) return true;
  for (const grant of accessGrants) {
    if (!grant || typeof grant !== 'object') continue;
    if (grant['permission'] !== 'read') continue;
    if (grant['principal_type'] === 'user' && (grant['principal_id'] === '*' || grant['principal_id'] === user.id)) {
      return true;
    }
    if (grant['principal_type'] === 'group' && userGroupIds.includes(grant['principal_id'])) return true;
  }
  return false;
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

async function canChangeToolCode(user: { id: string; role: string }): Promise<boolean> {
  if (user.role === 'admin') return true;
  const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
  return (
    (await hasPermission(user.id, 'workspace.tools', defaults)) ||
    (await hasPermission(user.id, 'workspace.tools_import', defaults))
  );
}

/** Shared create/update logic for tools (Python _update_tool). */
async function updateTool(
  ctx: Ctx,
  id: string,
  formData: { id?: string; name: string; content: string; meta: Record<string, any>; commit_message?: string | null },
  user: { id: string; role: string },
  versionId: string | null = null
) {
  const tools = await getToolById(id);
  if (!tools) err(401, EM.NOT_FOUND);

  if (
    tools.user_id !== user.id &&
    !(await hasAccessGrant(user.id, 'tool', tools.id, 'write')) &&
    user.role !== 'admin'
  ) {
    err(401, EM.UNAUTHORIZED);
  }

  const allowCodeChanges = await canChangeToolCode(user);
  if (formData.content !== tools.content && !allowCodeChanges) {
    err(401, EM.UNAUTHORIZED);
  }

  try {
    const content = versionId === null ? replaceImports(formData.content) : formData.content;
    const frontmatter = extractFrontmatter(content);
    const meta = {
      ...formData.meta,
      manifest: frontmatter,
      has_user_valves: sourceHasUserValves(content),
    };
    const specs = getToolSpecsFromSource(content);
    const updated = await updateToolById(
      id,
      {
        name: formData.name,
        content,
        specs,
        meta,
        commit_message: formData.commit_message ?? null,
      },
      user.id,
      versionId
    );
    if (updated) return updated;
    err(400, EM.DEFAULT('Error updating tools'));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    err(400, String((e as Error)?.message ?? e));
  }
}

async function requireToolHistoryAccess(ctx: Ctx, id: string) {
  const user = requireUser(ctx);
  const resource = await getToolById(id);
  if (!resource) err(404, 'Not found');
  if (
    !(
      (user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL) ||
      resource.user_id === user.id ||
      (await hasAccessGrant(user.id, 'tool', id, 'write'))
    )
  ) {
    err(401, EM.ACCESS_PROHIBITED);
  }
  return resource;
}

async function requireToolHistoryEntry(id: string, historyId: string) {
  const entry = await getToolHistoryById(id, historyId);
  if (!entry) err(404, 'Version not found');
  return entry;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // GET / — list tools visible to the user (+ tool servers)
  {
    method: 'GET',
    path: '',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const query = ctx.query.get('query');
      const bypass = user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL;
      const userGroupIds = bypass ? [] : await getUserGroupIds(user.id);

      const tools: any[] = [];
      if (ENABLE_TOOLS) {
        const localTools = await getTools({
          deferContent: true,
          userId: bypass ? null : user.id,
          userGroupIds,
        });
        for (const tool of localTools) {
          tools.push({
            ...tool,
            has_user_valves: tool.meta?.has_user_valves ?? false,
          });
        }
      }

      // OpenAPI tool servers
      const serverConnections: Record<string, any> = {};
      for (const server of await getToolServers()) {
        const connections = await configGet<any[]>('tool_server.connections', []);
        if (server.idx >= (connections ?? []).length) continue;
        const connection = connections[server.idx];
        const serverId = `server:${server.id}`;
        serverConnections[serverId] = connection;

        let filterList = (connection?.['config'] ?? {})['function_name_filter_list'] ?? '';
        if (typeof filterList === 'string') {
          filterList = filterList.split(',').map((s) => s.trim()).filter(Boolean);
        }
        tools.push({
          version_id: null,
          id: serverId,
          user_id: serverId,
          name: server.openapi?.['info']?.['title'] ?? 'Tool Server',
          content: null,
          specs: (server.specs ?? []).filter(
            (spec: any) => !filterList.length || isStringAllowed(spec['name'], filterList)
          ),
          meta: { description: server.openapi?.['info']?.['description'] ?? '' },
          access_grants: [],
          user: null,
          updated_at: nowSec(),
          created_at: nowSec(),
        });
      }

      // MCP tool servers
      if (ENABLE_TOOL_SERVERS) {
        const connections = await configGet<any[]>('tool_server.connections', []);
        for (const server of connections ?? []) {
          if ((server?.['type'] ?? 'openapi') === 'mcp' && (server?.['config'] ?? {})['enable']) {
            const info = server['info'] ?? {};
            const authType = server['auth_type'] ?? 'none';
            const toolId = `server:mcp:${info['id']}`;
            serverConnections[toolId] = server;
            tools.push({
              version_id: null,
              id: toolId,
              user_id: toolId,
              name: info['name'] ?? 'MCP Tool Server',
              content: null,
              specs: [],
              meta: { description: info['description'] ?? '' },
              access_grants: [],
              user: null,
              updated_at: nowSec(),
              created_at: nowSec(),
              ...(authType === 'oauth_2.1' || authType === 'oauth_2.1_static'
                ? { authenticated: false /* no oauth token manager runtime */ }
                : {}),
            });
          }
        }
      }

      let visible = tools;
      if (!bypass) {
        visible = [];
        for (const tool of tools) {
          if (!String(tool.id).startsWith('server:')) {
            visible.push(tool);
          } else if (await hasConnectionAccess(user, serverConnections[String(tool.id)], userGroupIds)) {
            visible.push(tool);
          }
        }
      }

      if (query) {
        const q = query.toLowerCase();
        visible = visible.filter((tool) => (tool.name ?? '').toLowerCase().includes(q));
      }

      return ctx.json(visible);
    },
  },

  // GET /id/:id/specs — MCP discovery (no MCP runtime → 404)
  {
    method: 'GET',
    path: 'id/:id/specs',
    auth: 'user',
    handler: async (ctx) => {
      void ctx;
      err(404, 'Tool not found');
    },
  },

  // GET /list
  {
    method: 'GET',
    path: 'list',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      if (!ENABLE_TOOLS) return ctx.json([]);

      const bypass = user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL;
      const userGroupIds = bypass ? [] : await getUserGroupIds(user.id);
      const tools = await getTools({
        deferContent: true,
        userId: bypass ? null : user.id,
        userGroupIds,
      });
      const result = tools.map((tool) => {
        const hasWrite =
          bypass ||
          user.id === tool.user_id ||
          tool.access_grants.some(
            (g) =>
              g.permission === 'write' &&
              ((g.principal_type === 'user' && (g.principal_id === user.id || g.principal_id === '*')) ||
                (g.principal_type === 'group' && userGroupIds.includes(g.principal_id)))
          );
        return { ...tool, write_access: hasWrite };
      });
      return ctx.json(result);
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
      const toolName =
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
        if (res.status !== 200) err(res.status, 'Failed to fetch the tool');
        const data = await res.text();
        if (!data) err(400, 'No data received from the URL');
        return ctx.json({ name: toolName, content: data });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(500, EM.DEFAULT(`Error fetching tool`));
      }
    },
  },

  // GET /export
  {
    method: 'GET',
    path: 'export',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
      if (user.role !== 'admin' && !(await hasPermission(user.id, 'workspace.tools_export', defaults))) {
        err(401, EM.UNAUTHORIZED);
      }
      const bypass = user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL;
      return ctx.json(
        await getTools({ userId: bypass ? null : user.id, permission: 'write' })
      );
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
        id?: string;
        name?: string;
        content?: string;
        meta?: Record<string, any>;
        access_grants?: any[] | null;
        commit_message?: string | null;
      }>();

      const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
      if (
        user.role !== 'admin' &&
        !(
          (await hasPermission(user.id, 'workspace.tools', defaults)) ||
          (await hasPermission(user.id, 'workspace.tools_import', defaults))
        )
      ) {
        err(401, EM.UNAUTHORIZED);
      }

      const id = String(form.id ?? '');
      if (!/^[A-Za-z_]\w*$/.test(id)) {
        err(400, 'Only alphanumeric characters and underscores are allowed in the id');
      }
      const toolId = id.toLowerCase();

      const existing = await getToolById(toolId);
      if (existing !== null) err(400, EM.ID_TAKEN);

      try {
        const allowedGrants = await filterAllowedAccessGrants(
          defaults,
          user.id,
          user.role,
          form.access_grants ?? null,
          'tool'
        );
        const content = replaceImports(String(form.content ?? ''));
        const frontmatter = extractFrontmatter(content);
        const meta = {
          description: null,
          ...(form.meta ?? {}),
          manifest: frontmatter,
          has_user_valves: sourceHasUserValves(content),
          ...getToolMetaFlags(content),
        };
        const specs = getToolSpecsFromSource(content);
        const tool = await insertNewTool(
          user.id,
          {
            id: toolId,
            name: String(form.name ?? ''),
            content,
            meta,
            access_grants: allowedGrants,
            commit_message: form.commit_message ?? null,
          },
          specs
        );
        if (tool) return ctx.json(tool);
        err(400, EM.DEFAULT('Error creating tools'));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        console.error(`Failed to load the tool by id ${toolId}: ${e}`);
        err(400, `Error creating tool: ${String((e as Error)?.message ?? e)}`);
      }
    },
  },

  // GET /id/:id
  {
    method: 'GET',
    path: 'id/:id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const tools = await getToolById(id);
      if (!tools) err(404, EM.NOT_FOUND);

      if (
        user.role === 'admin' ||
        tools.user_id === user.id ||
        (await hasAccessGrant(user.id, 'tool', tools.id, 'read'))
      ) {
        const writeAccess =
          (user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL) ||
          user.id === tools.user_id ||
          (await hasAccessGrant(user.id, 'tool', tools.id, 'write'));
        const data: Record<string, any> = { ...tools, user: null };
        if (!writeAccess) delete data['content'];
        return ctx.json({ ...data, write_access: writeAccess });
      }
      err(401, EM.ACCESS_PROHIBITED);
    },
  },

  // POST /id/:id/update
  {
    method: 'POST',
    path: 'id/:id/update',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const form = await ctx.body<any>();
      return ctx.json(await updateTool(ctx, ctx.params.id, form, user));
    },
  },

  // POST /id/:id/access/update
  {
    method: 'POST',
    path: 'id/:id/access/update',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const form = await ctx.body<{ access_grants?: any[] }>();

      const tools = await getToolById(id);
      if (!tools) err(404, EM.NOT_FOUND);

      if (
        tools.user_id !== user.id &&
        !(await hasAccessGrant(user.id, 'tool', tools.id, 'write')) &&
        user.role !== 'admin'
      ) {
        err(401, EM.UNAUTHORIZED);
      }

      const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
      const grants = await validateAccessGrants(defaults, user.id, user.role, form.access_grants ?? [], 'tool');
      await setAccessGrants('tool', id, grants);

      return ctx.json(await getToolById(id));
    },
  },

  // DELETE /id/:id/delete
  {
    method: 'DELETE',
    path: 'id/:id/delete',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const tools = await getToolById(id);
      if (!tools) err(401, EM.NOT_FOUND);

      if (
        tools.user_id !== user.id &&
        !(await hasAccessGrant(user.id, 'tool', tools.id, 'write')) &&
        user.role !== 'admin'
      ) {
        err(401, EM.UNAUTHORIZED);
      }

      const result = await deleteToolById(id);
      return ctx.json(result);
    },
  },

  // GET /id/:id/valves
  {
    method: 'GET',
    path: 'id/:id/valves',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const tools = await getToolById(id);
      if (!tools) err(404, EM.NOT_FOUND);
      if (
        tools.user_id !== user.id &&
        !(await hasAccessGrant(user.id, 'tool', tools.id, 'write')) &&
        user.role !== 'admin'
      ) {
        err(401, EM.ACCESS_PROHIBITED);
      }
      try {
        return ctx.json(await getToolValvesById(id));
      } catch (e) {
        err(400, `Error getting tool valves: ${String((e as Error)?.message ?? e)}`);
      }
    },
  },

  // GET /id/:id/valves/spec
  {
    method: 'GET',
    path: 'id/:id/valves/spec',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const tools = await getToolById(id);
      if (!tools) err(404, EM.NOT_FOUND);
      if (
        tools.user_id !== user.id &&
        !(await hasAccessGrant(user.id, 'tool', tools.id, 'write')) &&
        user.role !== 'admin'
      ) {
        err(401, EM.ACCESS_PROHIBITED);
      }
      const schema = getValvesSchema(tools.content ?? '', 'Valves');
      return ctx.json(resolveValvesSchemaOptions(schema));
    },
  },

  // POST /id/:id/valves/update
  {
    method: 'POST',
    path: 'id/:id/valves/update',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const tools = await getToolById(id);
      if (!tools) err(401, EM.NOT_FOUND);
      if (
        tools.user_id !== user.id &&
        !(await hasAccessGrant(user.id, 'tool', tools.id, 'write')) &&
        user.role !== 'admin'
      ) {
        err(400, EM.ACCESS_PROHIBITED);
      }

      const schema = getValvesSchema(tools.content ?? '', 'Valves');
      if (!schema) err(401, EM.NOT_FOUND);

      try {
        const formData = await ctx.body<Record<string, any>>();
        const filtered = Object.fromEntries(Object.entries(formData ?? {}).filter(([, v]) => v !== null));
        // Python validates against the pydantic model (extra keys dropped);
        // statically we keep known keys only and persist the merged dict.
        const known = new Set([...Object.keys(schema.properties ?? {})]);
        const current = (await getToolValvesById(id)) ?? {};
        const valvesDict: Record<string, any> = { ...current };
        for (const [k, v] of Object.entries(filtered)) {
          if (known.has(k)) valvesDict[k] = v;
        }
        await updateToolValvesById(id, valvesDict);
        return ctx.json(valvesDict);
      } catch (e) {
        console.error(`Failed to update tool valves by id ${id}: ${e}`);
        err(400, `Error updating tool valves: ${String((e as Error)?.message ?? e)}`);
      }
    },
  },

  // GET /id/:id/valves/user
  {
    method: 'GET',
    path: 'id/:id/valves/user',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const tools = await getToolById(id);
      if (!tools) err(404, EM.NOT_FOUND);
      if (
        tools.user_id !== user.id &&
        !(await hasAccessGrant(user.id, 'tool', tools.id, 'read')) &&
        user.role !== 'admin'
      ) {
        err(401, EM.ACCESS_PROHIBITED);
      }
      try {
        return ctx.json(await getUserValvesForTool(id, user.id));
      } catch (e) {
        err(400, `Error getting tool user valves: ${String((e as Error)?.message ?? e)}`);
      }
    },
  },

  // GET /id/:id/valves/user/spec
  {
    method: 'GET',
    path: 'id/:id/valves/user/spec',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const tools = await getToolById(id);
      if (!tools) err(404, EM.NOT_FOUND);
      if (
        tools.user_id !== user.id &&
        !(await hasAccessGrant(user.id, 'tool', tools.id, 'read')) &&
        user.role !== 'admin'
      ) {
        err(401, EM.ACCESS_PROHIBITED);
      }
      const schema = getValvesSchema(tools.content ?? '', 'UserValves');
      return ctx.json(resolveValvesSchemaOptions(schema));
    },
  },

  // POST /id/:id/valves/user/update
  {
    method: 'POST',
    path: 'id/:id/valves/user/update',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const tools = await getToolById(id);
      if (!tools) err(404, EM.NOT_FOUND);
      if (
        tools.user_id !== user.id &&
        !(await hasAccessGrant(user.id, 'tool', tools.id, 'read')) &&
        user.role !== 'admin'
      ) {
        err(401, EM.ACCESS_PROHIBITED);
      }

      const schema = getValvesSchema(tools.content ?? '', 'UserValves');
      if (schema) {
        try {
          const formData = await ctx.body<Record<string, any>>();
          const filtered = Object.fromEntries(Object.entries(formData ?? {}).filter(([, v]) => v !== null));
          const known = new Set([...Object.keys(schema.properties ?? {})]);
          const current = (await getUserValvesForTool(id, user.id)) ?? {};
          const userValves: Record<string, any> = { ...current };
          for (const [k, v] of Object.entries(filtered)) {
            if (known.has(k)) userValves[k] = v;
          }
          const saved = await updateUserValvesForTool(id, user.id, userValves);
          return ctx.json(saved);
        } catch (e) {
          console.error(`Failed to update user valves by id ${id}: ${e}`);
          err(400, `Error updating tool user valves: ${String((e as Error)?.message ?? e)}`);
        }
      } else {
        err(401, EM.NOT_FOUND);
      }
    },
  },

  // GET /id/:id/history (static paths before the :history_id route)
  {
    method: 'GET',
    path: 'id/:id/history',
    auth: 'user',
    handler: async (ctx) => {
      const page = Number(ctx.query.get('page') ?? 1) || 1;
      await requireToolHistoryAccess(ctx, ctx.params.id);
      return ctx.json(await getToolHistoryByToolId(ctx.params.id, page));
    },
  },

  // GET /id/:id/history/diff
  {
    method: 'GET',
    path: 'id/:id/history/diff',
    auth: 'user',
    handler: async (ctx) => {
      const id = ctx.params.id;
      await requireToolHistoryAccess(ctx, id);
      const fromId = ctx.query.get('from_id') ?? '';
      const toId = ctx.query.get('to_id') ?? '';
      const before = await requireToolHistoryEntry(id, fromId);
      const after = await requireToolHistoryEntry(id, toId);
      return ctx.json(toolDiff(before as any, after as any));
    },
  },

  // GET /id/:id/history/:history_id
  {
    method: 'GET',
    path: 'id/:id/history/:history_id',
    auth: 'user',
    handler: async (ctx) => {
      const id = ctx.params.id;
      await requireToolHistoryAccess(ctx, id);
      return ctx.json(await requireToolHistoryEntry(id, ctx.params.history_id));
    },
  },

  // DELETE /id/:id/history/:history_id
  {
    method: 'DELETE',
    path: 'id/:id/history/:history_id',
    auth: 'user',
    handler: async (ctx) => {
      const id = ctx.params.id;
      await requireToolHistoryAccess(ctx, id);
      if (!(await deleteToolHistoryEntry(id, ctx.params.history_id))) {
        err(404, 'Version not found');
      }
      return ctx.json(true);
    },
  },

  // POST /id/:id/update/version
  {
    method: 'POST',
    path: 'id/:id/update/version',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const form = await ctx.body<{ version_id?: string }>();
      await requireToolHistoryAccess(ctx, id);
      const entry = await requireToolHistoryEntry(id, String(form.version_id ?? ''));
      const snapshot = entry.snapshot ?? {};
      const saved = {
        id,
        name: String(snapshot['name'] ?? ''),
        content: String(snapshot['content'] ?? ''),
        meta: snapshot['meta'] ?? {},
      };
      return ctx.json(await updateTool(ctx, id, saved, user, entry.id));
    },
  },
];

