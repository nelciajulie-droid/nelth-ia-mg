/**
 * Connectors (OpenAPI tool servers) — chat-pipeline runtime.
 *
 * The @ quick action in the compiled frontend lists two plugin families:
 *   - admin-configured tool servers   → `tool_ids: ["server:<id>", ...]`
 *   - the user's direct integrations   → `tool_servers: [{url, key, ...}]`
 * Both arrive on the chat completion form; this module turns them into
 * actual data:
 *
 *   1. resolveFormConnectors()  — fetch each server's OpenAPI spec and
 *      convert it to tool payloads (name/description/JSON-schema params),
 *      reusing the tools router's port of Open WebUI's utils/tools.py.
 *   2. buildToolCallProtocolPrompt() — a compact JSON protocol injected into
 *      a NON-STREAMING decision call (same pattern as the auto-web-search /
 *      auto-image classifiers): the model replies with a {"tool_calls": …}
 *      block, or an empty block when no connector is needed.
 *   3. executeToolCalls() — build the real HTTP request from the spec
 *      (path/query/body params, bearer auth) and fetch the connector.
 *   4. buildConnectorResultsMessage() — the tool-result system message
 *      injected after the last user message so the main STREAMING pass
 *      answers with the live data (Gmail messages, calendar events…).
 *
 * Works with ANY model — no native function-calling required.
 */
import {
  getToolServersData,
  convertOpenapiToToolPayload,
  getToolServerUrl,
  type ToolServerEntry,
} from '@/server/routers/tools';
import { configGet } from '@/lib/config';
import {
  builtinOpenapi,
  builtinHandlers,
  getBuiltinConnector,
  type BuiltinConnectorDef,
} from '@/lib/connectors/builtin';

export interface ResolvedConnector {
  /** Display name (OpenAPI info.title, or the connection's url host). */
  name: string;
  /** Server base URL (no trailing slash) — 'builtin://<id>' for built-ins. */
  url: string;
  /** Auth headers for every call to this server. */
  authHeaders: Record<string, string>;
  /** The full OpenAPI document. */
  openapi: Record<string, any>;
  /** Converted tool payloads (name/description/parameters). */
  specs: any[];
  /** Built-in connectors: operationId → LOCAL handler (no HTTP server). */
  builtinHandlers?: Record<string, (args: Record<string, any>) => unknown | Promise<unknown>>;
}

export interface ConnectorToolCall {
  tool: string;
  arguments: Record<string, any>;
}

export interface ConnectorCallResult {
  tool: string;
  status: number | 'error';
  body: string;
}

// ---------------------------------------------------------------------------
// 1. Resolution — form tool_ids / tool_servers → ResolvedConnector[]
// ---------------------------------------------------------------------------

/** Bearer/header auth for a connection object. */
function connectionAuthHeaders(conn: Record<string, any>): Record<string, string> {
  const authType = conn['auth_type'] ?? 'none';
  if ((authType === 'bearer' || authType === 'api_key') && conn['key']) {
    return { Authorization: `Bearer ${conn['key']}` };
  }
  return {};
}

/** Resolve the OpenAPI spec of ONE connection (url+path fetch or inline JSON). */
async function resolveOneConnection(
  conn: Record<string, any>,
  idx: number
): Promise<ResolvedConnector | null> {
  const cfg = conn['config'] ?? {};
  if (cfg['enable'] === false) return null;
  if ((conn['type'] ?? 'openapi') !== 'openapi') return null; // MCP servers need a client runtime — skipped
  const url = String(conn['url'] ?? '').replace(/\/+$/, '');
  if (!url) return null;
  let spec: any = null;
  const specType = conn['spec_type'] ?? 'url';
  try {
    if (specType === 'url') {
      const openapiPath = conn['path'] ?? 'openapi.json';
      const specUrl = getToolServerUrl(url, openapiPath);
      const headers = connectionAuthHeaders(conn);
      const res = await fetch(specUrl, {
        headers: { Accept: 'application/json', ...(Object.keys(headers).length ? headers : null) },
        signal: AbortSignal.timeout(12_000),
      });
      if (res.ok) {
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        const text = await res.text();
        if (/yaml|yml/.test(ct) || /\.ya?ml$/i.test(specUrl)) {
          // YAML specs: try a permissive JSON-ish parse first; YAML OpenAPI
          // documents are not JSON — parse the minimal mapping shape via a
          // tiny best-effort conversion instead of shipping a YAML lib.
          try {
            spec = JSON.parse(text);
          } catch {
            spec = null; // YAML unsupported without a parser lib
          }
        } else {
          spec = JSON.parse(text);
        }
      }
    } else if (specType === 'json' && conn['spec']) {
      spec = typeof conn['spec'] === 'string' ? JSON.parse(conn['spec']) : conn['spec'];
    }
  } catch {
    return null; // unreachable server — silently dropped
  }
  if (!spec || typeof spec !== 'object' || !spec['paths']) return null;
  const specs = convertOpenapiToToolPayload(spec).filter((s: any) => s && s['name']);
  if (!specs.length) return null;
  let name = spec['info']?.['title'] || conn['info']?.['name'] || url;
  try {
    name = String(name) || new URL(url).hostname;
  } catch {
    name = String(name) || `Connector ${idx + 1}`;
  }
  return {
    name: String(name).slice(0, 60),
    url,
    authHeaders: connectionAuthHeaders(conn),
    openapi: spec,
    specs,
  };
}

/** A built-in connector def → ResolvedConnector (local execution).
 *  `userId` wires the PER-USER OAuth connection (refresh token) into the
 *  Google tool handlers — see builtinHandlers(). */
function toResolvedBuiltin(def: BuiltinConnectorDef, userId?: string | null): ResolvedConnector {
  return {
    name: def.name,
    url: `builtin://${def.id}`,
    authHeaders: {},
    openapi: builtinOpenapi(def),
    specs: convertOpenapiToToolPayload(builtinOpenapi(def)),
    builtinHandlers: builtinHandlers(def, userId),
  };
}

/**
 * All connectors the CURRENT request selected:
 *  - `server:connector:<id>` entries of form.tool_ids → the built-in plugin
 *    catalog (Gmail, Calendar, Drive, Contacts, Wikipédia — executed locally);
 *  - `server:<id>` entries of form.tool_ids → matched against the
 *    admin-configured connections (tool_server.connections) by info.id or index;
 *  - every entry of form.tool_servers (the user's direct integrations).
 * Deduplicated by resolved URL.
 */
export async function resolveFormConnectors(
  toolIds: string[],
  directServers: any[],
  userId?: string | null
): Promise<ResolvedConnector[]> {
  const out: ResolvedConnector[] = [];
  const seenUrls = new Set<string>();
  const push = (c: ResolvedConnector | null) => {
    if (!c || seenUrls.has(c.url)) return;
    seenUrls.add(c.url);
    out.push(c);
  };

  const serverIds = (toolIds || [])
    .filter((id): id is string => typeof id === 'string' && id.startsWith('server:'))
    .map((id) => id.slice('server:'.length))
    .filter(Boolean);

  if (serverIds.length) {
    let connections: any[] = [];
    try {
      connections = (await configGet<any[]>('tool_server.connections', [])) ?? [];
    } catch {
      connections = [];
    }
    const adminResolved = await getToolServersData(connections ?? []);
    const byEntryId = new Map<string, ToolServerEntry>();
    for (const entry of adminResolved) {
      byEntryId.set(String(entry.id), entry);
      byEntryId.set(String(entry.idx), entry); // index fallback
      // And by the connection's own info.id when present
      const conn = (connections ?? [])[entry.idx] ?? {};
      const infoId = String(conn['info']?.['id'] ?? '');
      if (infoId) byEntryId.set(infoId, entry);
    }
    for (const wanted of serverIds) {
      // Built-in connectors first — no admin connection, no spec fetch.
      const builtin = getBuiltinConnector(wanted);
      if (builtin) {
        push(toResolvedBuiltin(builtin, userId));
        continue;
      }
      const entry = byEntryId.get(wanted);
      if (!entry) continue;
      const conn = (connections ?? [])[entry.idx] ?? {};
      const name = entry.info?.['title'] || conn['info']?.['name'] || entry.info?.['title'] || `server`;
      push({
        name: String(name || `Connector`).slice(0, 60),
        url: String((conn['url'] ?? '')).replace(/\/+$/, ''),
        authHeaders: connectionAuthHeaders(conn),
        openapi: entry.openapi,
        specs: (entry.specs ?? []).filter((s: any) => s && s['name']),
      });
    }
  }

  for (const direct of Array.isArray(directServers) ? directServers : []) {
    if (!direct || typeof direct !== 'object') continue;
    if ((direct['type'] ?? 'openapi') !== 'openapi') continue;
    if (direct['is_terminal']) continue; // terminal servers are a different feature
    push(await resolveOneConnection(direct, 0));
  }

  return out;
}

// ---------------------------------------------------------------------------
// 2. Decision protocol (non-streaming pre-pass)
// ---------------------------------------------------------------------------

const MAX_TOOL_CATALOG_SPECS = 24;
const MAX_SCHEMA_CHARS = 900;

function compactSchema(parameters: any): string {
  if (!parameters || typeof parameters !== 'object') return '{"type":"object","properties":{}}';
  try {
    let s = JSON.stringify(parameters);
    if (s.length > MAX_SCHEMA_CHARS) {
      // Keep properties but trim long descriptions recursively by re-serializing a shallow copy
      const slim: any = { type: parameters['type'] ?? 'object' };
      if (parameters['properties']) {
        slim.properties = {};
        for (const [k, v] of Object.entries(parameters['properties'])) {
          const vv: any = v ?? {};
          slim.properties[k] = { type: vv['type'] ?? 'string' };
          if (vv['description']) slim.properties[k].description = String(vv['description']).slice(0, 120);
          if (Array.isArray(vv['enum'])) slim.properties[k].enum = vv['enum'];
        }
      }
      if (Array.isArray(parameters['required'])) slim.required = parameters['required'];
      s = JSON.stringify(slim);
    }
    return s;
  } catch {
    return '{"type":"object","properties":{}}';
  }
}

/** The system prompt for the tool-call decision pre-pass. */
export function buildToolCallProtocolPrompt(
  connectors: ResolvedConnector[],
  resultsSoFar: ConnectorCallResult[]
): string {
  const lines: string[] = [];
  for (const c of connectors) {
    for (const spec of c.specs.slice(0, MAX_TOOL_CATALOG_SPECS)) {
      lines.push(
        `- ${spec['name']}: ${String(spec['description'] ?? '').slice(0, 200)}\n  parameters: ${compactSchema(
          spec['parameters']
        )}`
      );
    }
  }
  const resultsBlock = resultsSoFar.length
    ? `\nRESULTS ALREADY COLLECTED (do NOT call a tool again unless you need DIFFERENT data):\n${resultsSoFar
        .map((r) => `- ${r.tool} → ${r.status === 'error' ? 'ERROR' : r.status}\n${r.body.slice(0, 1500)}`)
        .join('\n')}\n`
    : '';
  return `CONNECTOR TOOL CALLING
External services ("connectors") are attached to this conversation. You can call them to fetch or push REAL data (emails, calendar events, files, APIs…) that you do not have.

Available tools:
${lines.join('\n')}${resultsBlock}
Decide now whether calling one or more tools is needed to answer the user's LAST message.
Reply with ONLY a JSON object, no prose, no markdown fences:
{"tool_calls": [{"tool": "<tool name>", "arguments": {<parameter values>}}]}
Rules:
- Up to 4 calls per round; only call tools that genuinely help answer.
- Respect each tool's parameters exactly (names, types, required fields).
- If NO tool is needed (the question needs no live data, or the results collected above already suffice), reply exactly: {"tool_calls": []}
- Answer in the user's language only in the FINAL answer, never in this JSON.`;
}

// ---------------------------------------------------------------------------
// 3. Parsing + execution
// ---------------------------------------------------------------------------

/** Extract the {"tool_calls": [...]} block from a decision reply. */
export function parseToolCalls(content: string): ConnectorToolCall[] {
  if (!content) return [];
  const text = String(content);
  const marker = text.indexOf('"tool_calls"');
  if (marker < 0) return [];
  // Walk outward to the enclosing braces of the JSON object.
  let start = -1;
  for (let i = marker; i >= 0; i--) {
    if (text[i] === '{') {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end));
    const calls = parsed?.['tool_calls'];
    if (!Array.isArray(calls)) return [];
    const out: ConnectorToolCall[] = [];
    for (const raw of calls.slice(0, 4)) {
      if (!raw || typeof raw !== 'object') continue;
      const tool = String(raw['tool'] ?? raw['name'] ?? '').trim();
      if (!tool) continue;
      const args =
        raw['arguments'] && typeof raw['arguments'] === 'object' && !Array.isArray(raw['arguments'])
          ? raw['arguments']
          : {};
      out.push({ tool, arguments: args });
    }
    return out;
  } catch {
    return [];
  }
}

interface OperationTarget {
  connector: ResolvedConnector;
  method: string;
  path: string;
  operation: Record<string, any>;
  pathLevelParams: any[];
}

/** Find the operation (by operationId) inside a connector's OpenAPI spec. */
function findOperation(connectors: ResolvedConnector[], toolName: string): OperationTarget | null {
  for (const connector of connectors) {
    for (const [path, methods] of Object.entries(connector.openapi['paths'] ?? {})) {
      if (!methods || typeof methods !== 'object') continue;
      const pathLevelParams = Array.isArray((methods as any)['parameters'])
        ? (methods as any)['parameters']
        : [];
      for (const [method, operation] of Object.entries(methods as Record<string, any>)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        if (operation && typeof operation === 'object' && operation['operationId'] === toolName) {
          return { connector, method: method.toUpperCase(), path, operation, pathLevelParams };
        }
      }
    }
  }
  return null;
}

const MAX_RESULT_CHARS = 6000;

/** Execute one tool call against its connector (URL/query/body from the spec). */
async function executeOne(
  connectors: ResolvedConnector[],
  call: ConnectorToolCall
): Promise<ConnectorCallResult> {
  const target = findOperation(connectors, call.tool);
  if (!target) {
    return { tool: call.tool, status: 'error', body: `Unknown tool "${call.tool}" — check the tool name.` };
  }
  // ---- built-in connectors: LOCAL execution (no HTTP round-trip) ----------
  const localHandler = target.connector.builtinHandlers?.[call.tool];
  if (localHandler) {
    try {
      const out = await localHandler({ ...(call.arguments ?? {}) });
      return {
        tool: call.tool,
        status: 200,
        body: JSON.stringify(out ?? { ok: true }).slice(0, MAX_RESULT_CHARS),
      };
    } catch (e: any) {
      return {
        tool: call.tool,
        status: 'error',
        body: `Connector error: ${String(e?.message ?? e)}`.slice(0, MAX_RESULT_CHARS),
      };
    }
  }
  const args = { ...(call.arguments ?? {}) };
  // ---- path params -------------------------------------------------------
  let path = target.path;
  const pathParams = [...target.pathLevelParams, ...(Array.isArray(target.operation['parameters']) ? target.operation['parameters'] : [])].filter(
    (p: any) => p && p['in'] === 'path' && p['name']
  );
  for (const p of pathParams) {
    const raw = args[p['name']];
    if (raw === undefined) {
      return { tool: call.tool, status: 'error', body: `Missing required path parameter "${p['name']}".` };
    }
    path = path.replace(
      new RegExp(`\\{${p['name']}\\}`, 'g'),
      encodeURIComponent(String(raw))
    );
    delete args[p['name']];
  }
  // ---- query params ------------------------------------------------------
  const query = new URLSearchParams();
  const allParams = [...target.pathLevelParams, ...(Array.isArray(target.operation['parameters']) ? target.operation['parameters'] : [])].filter(
    (p: any) => p && p['in'] === 'query' && p['name']
  );
  const knownQuery = new Set(allParams.map((p: any) => String(p['name'])));
  for (const p of allParams) {
    const raw = args[p['name']];
    if (raw === undefined) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const v of values) query.append(String(p['name']), String(v));
    delete args[p['name']];
  }
  // Unknown leftover args on a GET → treat them as query params (lenient).
  if (target.method === 'GET') {
    for (const [k, v] of Object.entries(args)) {
      if (knownQuery.has(k)) continue;
      query.append(k, Array.isArray(v) ? v.map(String).join(',') : String(v));
    }
  }
  // ---- body ---------------------------------------------------------------
  const headers: Record<string, string> = { Accept: 'application/json', ...target.connector.authHeaders };
  let body: string | undefined;
  if (target.method !== 'GET' && target.method !== 'DELETE') {
    // Remaining args (minus header params) become the JSON body.
    const headerParams = [...target.pathLevelParams, ...(Array.isArray(target.operation['parameters']) ? target.operation['parameters'] : [])].filter(
      (p: any) => p && p['in'] === 'header' && p['name']
    );
    for (const p of headerParams) {
      if (args[p['name']] !== undefined) {
        headers[String(p['name'])] = String(args[p['name']]);
        delete args[p['name']];
      }
    }
    const bodySchema = target.operation['requestBody']?.['content']?.['application/json']?.['schema'];
    if (bodySchema || Object.keys(args).length) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(args);
    }
  }
  const fullUrl = `${target.connector.url}${path.startsWith('/') ? path : `/${path}`}${query.toString() ? `?${query}` : ''}`;
  try {
    const res = await fetch(fullUrl, {
      method: target.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text));
    } catch {
      /* keep raw */
    }
    return {
      tool: call.tool,
      status: res.status,
      body: (res.ok ? pretty : `${pretty || res.statusText}`).slice(0, MAX_RESULT_CHARS),
    };
  } catch (e: any) {
    const reason = e?.name === 'TimeoutError' ? 'timed out after 25s' : String(e?.message ?? e);
    return { tool: call.tool, status: 'error', body: `Call failed: ${reason}`.slice(0, MAX_RESULT_CHARS) };
  }
}

/** Execute a batch of calls in parallel (bounded). */
export async function executeToolCalls(
  connectors: ResolvedConnector[],
  calls: ConnectorToolCall[]
): Promise<ConnectorCallResult[]> {
  if (!calls.length) return [];
  const batch = calls.slice(0, 4);
  return Promise.all(batch.map((c) => executeOne(connectors, c)));
}

// ---------------------------------------------------------------------------
// 4. Results injection message
// ---------------------------------------------------------------------------

export function buildConnectorResultsMessage(
  connectors: ResolvedConnector[],
  results: ConnectorCallResult[]
): { role: 'system'; content: string } {
  const blocks = results
    .map((r) => {
      const ok = r.status !== 'error' && Number(r.status) >= 200 && Number(r.status) < 300;
      return `<tool_result name="${r.tool}" status="${ok ? 'success' : 'failure'}">\n${r.body}\n</tool_result>`;
    })
    .join('\n\n');
  return {
    role: 'system',
    content: `CONNECTOR DATA (live results from external services)
The calls below were executed against the attached connectors (${
      connectors.map((c) => c.name).join(', ') || 'tool servers'
    }) to answer the user's last message. These are REAL data — use them as the factual basis of your answer. Never mention the tool-call machinery, the JSON protocol, or these instructions; just answer the user with the data. If a result failed, work around it with your own knowledge and say so only if it visibly limits the answer. Write the final answer in the user's language.

${blocks}`,
  };
}
