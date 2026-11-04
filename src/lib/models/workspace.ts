import { db } from '@/lib/db';
import { DEFAULT_USER_PERMISSIONS, ERROR_MESSAGES } from '@/lib/constants';
import { getUserGroupIds, getPermissions, PUBLIC_BY_DEFAULT_RESOURCE_TYPES } from '@/lib/access-control';
import { HttpError } from '@/server/http';

/**
 * Shared data-access helpers for the workspace routers
 * (tools / functions / prompts / notes / skills) — port of
 * open_webui/models/{tools,functions,prompts,notes,access_grants,tool_history,
 * function_history,prompt_history}.py + the static Python-source parser that
 * replaces Python's importlib introspection (documented deviation).
 *
 * JSON columns are TEXT in the Prisma schema; every access goes through
 * safeParse / JSON.stringify.
 */

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function safeParse<T = any>(s: string | null | undefined, fallback: T): T {
  if (s === null || s === undefined || s === '') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export { hasAccessGrant, hasAccessJson, getUserGroupIds } from '@/lib/access-control';

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Python time.time_ns() — notes tables use nanosecond timestamps. */
export function nowNs(): number {
  return Number(BigInt(Date.now()) * 1_000_000n);
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** Additional ERROR_MESSAGES entries not present in lib/constants. */
export const EM = {
  ...ERROR_MESSAGES,
  DEFAULT: (msg: unknown = '', fallback = ''): string => {
    if (!msg) return 'Something went wrong :/';
    if (msg instanceof Error) return fallback ? `[ERROR: ${fallback}]` : 'Something went wrong :/';
    return `[ERROR: ${String(msg)}]`;
  },
  ID_TAKEN: 'Uh-oh! This id is already registered. Please choose another id string.',
  COMMAND_TAKEN: 'Uh-oh! This command is already registered. Please choose another command string.',
  FEATURE_DISABLED: (name = ''): string => `${name} is disabled`,
};

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function titleCase(name: string): string {
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

// ---------------------------------------------------------------------------
// Valves (models use TEXT columns; ENABLE_VALVE_ENCRYPTION defaults to False
// in Python, so plain JSON storage matches the default deployment).
// ---------------------------------------------------------------------------

export function encryptValves(valves: Record<string, unknown> | null): string {
  return JSON.stringify(valves ?? {});
}

export function decryptValves(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {};
  const parsed = safeParse<any | null>(raw, null);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  // Fernet-encrypted strings (ENABLE_VALVE_ENCRYPTION=True deployments) cannot
  // be decrypted without the Python runtime — match Python's failure path ({})
  return {};
}

// ---------------------------------------------------------------------------
// Access grants (models/access_grants.py)
// ---------------------------------------------------------------------------

export type AccessGrantModel = {
  id: string;
  resource_type: string;
  resource_id: string;
  principal_type: 'user' | 'group' | 'anyone';
  principal_id: string;
  permission: 'read' | 'write';
  created_at: number;
};

const PRINCIPAL_TYPES = new Set(['user', 'group', 'anyone']);
const WILDCARD = '*';

/** Python normalize_access_grants — validate + dedupe by (type, id, permission). */
export function normalizeAccessGrants(accessGrants: any[] | null | undefined): any[] {
  if (!accessGrants) return [];
  const deduped = new Map<string, any>();
  for (const grant of accessGrants) {
    if (!grant || typeof grant !== 'object') continue;
    const principal_type = grant.principal_type;
    const principal_id = grant.principal_id;
    const permission = grant.permission;
    if (!PRINCIPAL_TYPES.has(principal_type)) continue;
    if (permission !== 'read' && permission !== 'write') continue;
    if (typeof principal_id !== 'string' || !principal_id) continue;
    if (principal_type === 'anyone' && (principal_id !== WILDCARD || permission !== 'read')) continue;
    deduped.set(`${principal_type}:${principal_id}:${permission}`, {
      id: typeof grant.id === 'string' && grant.id ? grant.id : uuid(),
      principal_type,
      principal_id,
      permission,
    });
  }
  return [...deduped.values()];
}

function grantRowToModel(row: {
  id: string;
  resource_type: string;
  resource_id: string;
  principal_type: string;
  principal_id: string;
  permission: string;
  created_at: number;
}): AccessGrantModel {
  return row as AccessGrantModel;
}

export async function getGrantsByResource(resourceType: string, resourceId: string): Promise<AccessGrantModel[]> {
  const rows = await db.accessGrant.findMany({
    where: { resource_type: resourceType, resource_id: resourceId },
    orderBy: { created_at: 'asc' },
  });
  return rows.map(grantRowToModel);
}

export async function getGrantsByResources(
  resourceType: string,
  resourceIds: string[]
): Promise<Record<string, AccessGrantModel[]>> {
  const out: Record<string, AccessGrantModel[]> = {};
  if (!resourceIds.length) return out;
  for (const id of resourceIds) out[id] = [];
  const rows = await db.accessGrant.findMany({
    where: { resource_type: resourceType, resource_id: { in: resourceIds } },
    orderBy: { created_at: 'asc' },
  });
  for (const row of rows) out[row.resource_id]?.push(grantRowToModel(row));
  return out;
}

/** Python AccessGrants.set_access_grants — replace all grants for a resource. */
export async function setAccessGrants(
  resourceType: string,
  resourceId: string,
  accessGrants: any[] | null | undefined
): Promise<AccessGrantModel[]> {
  await db.accessGrant.deleteMany({ where: { resource_type: resourceType, resource_id: resourceId } });
  const normalized = normalizeAccessGrants(accessGrants);
  const created: AccessGrantModel[] = [];
  for (const grant of normalized) {
    const row = await db.accessGrant.create({
      data: {
        id: uuid(),
        resource_type: resourceType,
        resource_id: resourceId,
        principal_type: grant.principal_type,
        principal_id: grant.principal_id,
        permission: grant.permission,
        created_at: nowSec(),
      },
    });
    created.push(grantRowToModel(row));
  }
  return created;
}

export async function revokeAllAccess(resourceType: string, resourceId: string): Promise<number> {
  const res = await db.accessGrant.deleteMany({
    where: { resource_type: resourceType, resource_id: resourceId },
  });
  return res.count;
}

/** Python AccessGrants.get_accessible_resource_ids — batch permission check.
 *  PUBLIC-APP EXTENSION: shared-catalog resources (model/tool/skill/prompt/
 *  knowledge) without any grant row are public for read access. */
export async function getAccessibleResourceIds(
  userId: string,
  resourceType: string,
  resourceIds: string[],
  permission: 'read' | 'write' = 'read',
  userGroupIds?: string[]
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!resourceIds.length) return out;
  const groups = userGroupIds ?? (await getUserGroupIds(userId));
  const publicByDefault =
    permission === 'read' && PUBLIC_BY_DEFAULT_RESOURCE_TYPES.has(resourceType);
  const rows = await db.accessGrant.findMany({
    where: {
      resource_type: resourceType,
      resource_id: { in: resourceIds },
    },
    select: { resource_id: true, permission: true, principal_type: true, principal_id: true },
  });
  const withGrants = new Set(rows.map((r) => r.resource_id));
  if (publicByDefault) {
    for (const id of resourceIds) {
      if (!withGrants.has(id)) out.add(id);
    }
  }
  for (const row of rows) {
    if (row.permission !== permission) continue;
    const principalMatch =
      (row.principal_type === 'user' && (row.principal_id === WILDCARD || row.principal_id === userId)) ||
      (row.principal_type === 'group' && groups.includes(row.principal_id));
    if (principalMatch) out.add(row.resource_id);
  }
  return out;
}

export function hasPublicWriteAccessGrant(grants: any[] | null | undefined): boolean {
  return normalizeAccessGrants(grants).some(
    (g) => g.principal_type === 'user' && g.principal_id === WILDCARD && g.permission === 'write'
  );
}

// ---------------------------------------------------------------------------
// Sharing policy (utils/access_control filter/validate_access_grants)
// ---------------------------------------------------------------------------

const SHARING_PERMISSION_KEYS: Record<string, [string | null, string | null, string | null]> = {
  model: ['sharing.models', 'sharing.public_models', null],
  knowledge: ['sharing.knowledge', 'sharing.public_knowledge', null],
  prompt: ['sharing.prompts', 'sharing.public_prompts', null],
  tool: ['sharing.tools', 'sharing.public_tools', null],
  skill: ['sharing.skills', 'sharing.public_skills', null],
  note: ['sharing.notes', 'sharing.public_notes', null],
  folder: ['sharing.folders', null, null],
  channel: [null, 'sharing.public_channels', null],
  calendar: [null, 'sharing.public_calendars', null],
  shared_chat: [null, 'sharing.public_chats', 'sharing.open_chats'],
};

function permissionAllowed(permissions: Record<string, any>, key: string | null): boolean {
  if (!key) return false;
  const [section, name] = key.split('.');
  return Boolean(permissions?.[section]?.[name] ?? false);
}

/** Python filter_allowed_access_grants — filter initial sharing on create. */
export async function filterAllowedAccessGrants(
  defaultPermissions: Record<string, any> | null,
  userId: string,
  userRole: string,
  accessGrants: any[] | null | undefined,
  resourceType: string
): Promise<any[] | null> {
  const entry = SHARING_PERMISSION_KEYS[resourceType];
  if (!entry) throw new HttpError(500, `Unsupported sharing resource type: ${resourceType}`);
  const [sharingKey, publicKey, anyoneKey] = entry;

  if (!accessGrants) return accessGrants ?? null;

  let grants = normalizeAccessGrants(accessGrants);
  if (anyoneKey === null) {
    grants = grants.filter((g) => g.principal_type !== 'anyone');
  }
  if (publicKey === null) {
    grants = grants.filter((g) => !(g.principal_type === 'user' && g.principal_id === WILDCARD));
  }

  if (userRole === 'admin' || !grants.length) return grants;

  const permissions = await getPermissions(userId, defaultPermissions ?? null);

  if (sharingKey && !permissionAllowed(permissions, sharingKey)) return [];

  const allowedAudience = {
    anyone: permissionAllowed(permissions, anyoneKey),
    public: permissionAllowed(permissions, publicKey),
    user: permissionAllowed(permissions, 'access_grants.allow_users'),
    group: permissionAllowed(permissions, 'access_grants.allow_groups'),
  };
  return grants.filter((g) =>
    g.principal_type === 'user' && g.principal_id === WILDCARD
      ? allowedAudience.public
      : allowedAudience[g.principal_type as 'user' | 'group' | 'anyone']
  );
}

/** Python validate_access_grants — reject unauthorized sharing changes. */
export async function validateAccessGrants(
  defaultPermissions: Record<string, any> | null,
  userId: string,
  userRole: string,
  accessGrants: any[],
  resourceType: string
): Promise<any[]> {
  const grants = normalizeAccessGrants(accessGrants);
  const allowed = (await filterAllowedAccessGrants(defaultPermissions, userId, userRole, grants, resourceType)) ?? [];
  if (allowed.length !== grants.length) {
    throw new HttpError(403, 'You do not have permission to share with the requested audience');
  }
  return allowed;
}

// ---------------------------------------------------------------------------
// User helpers
// ---------------------------------------------------------------------------

export type UserRow = {
  id: string;
  email: string | null;
  name: string;
  role: string | null;
  settings: string | null;
  info: string | null;
  last_active_at: number | null;
};

/** Python UserResponse — {id, name, role, email}. */
export function toUserResponse(user: {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
}): { id: string; name: string; role: string; email: string } | null {
  if (!user) return null;
  return { id: user.id, name: user.name, role: user.role ?? 'pending', email: user.email ?? '' };
}

export async function getUsersByIds(userIds: string[]): Promise<UserRow[]> {
  if (!userIds.length) return [];
  return db.user.findMany({ where: { id: { in: userIds } } });
}

export async function getUserSettings(userId: string): Promise<Record<string, any>> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { settings: true } });
  return safeParse<Record<string, any>>(user?.settings ?? null, {}) ?? {};
}

export async function updateUserSettings(userId: string, settings: Record<string, any>): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { settings: JSON.stringify(settings) } });
}

// ---------------------------------------------------------------------------
// Static Python-source parser (documented deviation from importlib)
// ---------------------------------------------------------------------------

/**
 * Deviation note: Python imports the tool/function source with importlib and
 * introspects the live module (get_tool_specs, Valves.schema(), hasattr checks).
 * TS cannot exec Python, so this parser statically extracts the same
 * information from the source text with regexes:
 *   - `class <Name>:` bodies (module level)
 *   - `def <name>(self, ...)` methods with annotations, defaults and docstrings
 *   - class attributes with pydantic `Field(...)` kwargs
 */

export function extractFrontmatter(content: string): Record<string, string> {
  const frontmatter: Record<string, string> = {};
  try {
    const lines = content.split('\n');
    if (!lines.length || lines[0].trim() !== '"""') return {};
    const pattern = /^\s*([a-z_]+):\s*(.*)\s*$/i;
    for (const line of lines.slice(1)) {
      if (line.includes('"""')) break;
      const m = line.match(pattern);
      if (m) frontmatter[m[1].trim()] = m[2].trim();
    }
  } catch {
    return {};
  }
  return frontmatter;
}

/** Python replace_imports (utils/plugin.py). */
export function replaceImports(content: string): string {
  return content
    .replace(/from utils/g, 'from open_webui.utils')
    .replace(/from apps/g, 'from open_webui.apps')
    .replace(/from main/g, 'from open_webui.main')
    .replace(/from config/g, 'from open_webui.config');
}

type ClassBody = { name: string; lines: string[] };

/** Extract top-level (module-level) `class X(...):` bodies, dedented one level. */
function extractTopLevelClasses(source: string): Map<string, ClassBody> {
  const classes = new Map<string, ClassBody>();
  const lines = source.split('\n');
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^(?:@[^\n]+\n?)*class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/);
    if (m && !/^\s/.test(lines[i])) {
      const name = m[1];
      const body: string[] = [];
      let j = i + 1;
      let indent: number | null = null;
      while (j < lines.length) {
        const line = lines[j];
        if (line.trim() === '') {
          body.push('');
          j++;
          continue;
        }
        const lineIndent = line.length - line.replace(/^\s+/, '').length;
        if (indent === null) indent = lineIndent;
        if (lineIndent < indent && line.trim() !== '') break;
        body.push(line.slice(indent));
        j++;
      }
      classes.set(name, { name, lines: body });
      i = j;
    } else {
      i++;
    }
  }
  return classes;
}

/** Module-level simple assignments (`name = <literal>`), zero indentation. */
function extractModuleLevelAssignments(source: string): Record<string, any> {
  const out: Record<string, any> = {};
  for (const line of source.split('\n')) {
    const m = line.match(/^([A-Za-z_]\w*)\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (m) {
      const value = parsePythonLiteral(m[2]);
      if (value !== undefined) out[m[1]] = value;
    }
  }
  return out;
}

/** Class-body simple assignments (`name = <literal>` or `name: T = <literal>`). */
function extractClassAssignments(body: ClassBody): Record<string, any> {
  const out: Record<string, any> = {};
  for (const line of body.lines) {
    const m = line.match(/^([A-Za-z_]\w*)\s*(?::\s*[^=]+)?=\s*(.+?)\s*(?:#.*)?$/);
    if (m && !/^\s/.test(line)) {
      const value = parsePythonLiteral(m[2]);
      if (value !== undefined) out[m[1]] = value;
    }
  }
  return out;
}

/** Evaluate simple Python literals: True/False/None/numbers/strings/dicts/lists. */
export function parsePythonLiteral(text: string): any {
  if (text === undefined || text === null) return undefined;
  const t = text.trim().replace(/,$/, '');
  if (!t) return undefined;
  if (t === 'True') return true;
  if (t === 'False') return false;
  if (t === 'None') return null;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d*\.\d+(e-?\d+)?$/i.test(t)) return parseFloat(t);
  const str = t.match(/^(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')$/);
  if (str) {
    const raw = (str[1] ?? str[2]).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\'/g, "'").replace(/\\"/g, '"');
    return raw;
  }
  if (/^[([{]/.test(t)) {
    // best-effort: convert Python literal to JSON and parse
    const jsonish = t
      .replace(/([{[(,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')
      .replace(/'/g, '"')
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/\bNone\b/g, 'null');
    try {
      return JSON.parse(jsonish);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Split a comma-separated argument list respecting brackets and quotes. */
function splitArgs(argsText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];
    if (quote) {
      current += ch;
      if (ch === quote && argsText[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

type ParsedMethod = {
  name: string;
  args: Array<{ name: string; annotation: string; default?: string }>;
  docstring: string;
};

function parseClassMethods(body: ClassBody): ParsedMethod[] {
  const methods: ParsedMethod[] = [];
  const lines = body.lines;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:\s*)(?:async\s+)?def\s+(\w+)\s*\(/);
    if (!m) continue;
    // Gather the full signature (may span lines)
    let sig = lines[i].slice(lines[i].indexOf('('));
    let open = 0;
    let j = i;
    let closed = false;
    for (; j < lines.length && !closed; j++) {
      const text = j === i ? sig : lines[j];
      for (const ch of text) {
        if (ch === '(') open++;
        else if (ch === ')') {
          open--;
          if (open === 0) {
            closed = true;
            break;
          }
        }
      }
      if (!closed && j === i) sig = lines[i].slice(lines[i].indexOf('('));
    }
    // Rebuild the signature text properly across lines
    let signatureText = '';
    let parenDepth = 0;
    let done = false;
    for (let k = i; k < lines.length && !done; k++) {
      for (const ch of lines[k]) {
        signatureText += ch;
        if (ch === '(') parenDepth++;
        else if (ch === ')') {
          parenDepth--;
          if (parenDepth === 0) {
            done = true;
            break;
          }
        }
      }
      if (!done) signatureText += '\n';
    }
    const argsText = signatureText.slice(signatureText.indexOf('(') + 1, signatureText.lastIndexOf(')'));
    const args: ParsedMethod['args'] = [];
    for (const part of splitArgs(argsText.replace(/\n/g, ' '))) {
      if (!part || part === 'self' || part.startsWith('*')) continue;
      const am = part.match(/^([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+))?$/);
      if (am) {
        args.push({
          name: am[1],
          annotation: am[2]?.trim() ?? '',
          default: am[3]?.trim(),
        });
      }
    }
    // Docstring: first statement after the def
    let docstring = '';
    let k = (done ? i : i) + 1;
    // Find the signature end line index
    let sigEnd = i;
    {
      let depth = 0;
      let found = false;
      for (let x = i; x < lines.length && !found; x++) {
        for (const ch of lines[x]) {
          if (ch === '(') depth++;
          else if (ch === ')') {
            depth--;
            if (depth === 0) {
              found = true;
              break;
            }
          }
        }
        if (found) sigEnd = x;
      }
    }
    k = sigEnd + 1;
    while (k < lines.length && lines[k].trim() === '') k++;
    if (k < lines.length) {
      const dm = lines[k].match(/^\s*(?:"""|''')/);
      if (dm) {
        const quote = dm[0].trim();
        const rest = lines[k].slice(lines[k].indexOf(quote) + 3);
        if (rest.includes(quote)) {
          docstring = rest.slice(0, rest.indexOf(quote));
        } else {
          const parts = [rest];
          let x = k + 1;
          for (; x < lines.length; x++) {
            if (lines[x].includes(quote)) {
              parts.push(lines[x].slice(0, lines[x].indexOf(quote)));
              break;
            }
            parts.push(lines[x]);
          }
          docstring = parts.join('\n');
        }
      }
    }
    methods.push({ name: m[1], args, docstring });
  }
  return methods;
}

/** Python parse_description — text before :param/:return directives. */
function parseDescription(docstring: string): string {
  if (!docstring) return '';
  const lines = docstring.trim().split('\n').map((l) => l.trim());
  const out: string[] = [];
  for (const line of lines) {
    if (/^:param/.test(line) || /^:return/.test(line)) break;
    out.push(line);
  }
  return out.join('\n');
}

/** Python parse_docstring — `:param name: description` map. */
function parseDocstringParams(docstring: string): Record<string, string> {
  if (!docstring) return {};
  const paramPattern = /^:param\s+(\w+)\s*:\s*(.*)/;
  const descriptions: Record<string, string> = {};
  let currentParam: string | null = null;
  for (const rawLine of docstring.split('\n')) {
    const line = rawLine.trim();
    const m = line.match(paramPattern);
    if (m) {
      const [, name, description] = m;
      currentParam = name.startsWith('__') ? null : name;
      if (currentParam) descriptions[currentParam] = description;
      continue;
    }
    if (line.startsWith(':')) {
      currentParam = null;
      continue;
    }
    if (currentParam && line) {
      descriptions[currentParam] = [descriptions[currentParam], line].filter(Boolean).join('\n');
    }
  }
  return descriptions;
}

/** Map a Python annotation to a JSON-schema type (Optional[...] unwrapped). */
function annotationToType(annotation: string): string {
  let t = (annotation || '').trim();
  const optional = /^(Optional|Union)\[(.*),\s*None\]$|^(Optional|Union)\[None,\s*(.*)\]$/i.exec(t);
  if (optional) t = (optional[2] ?? optional[4] ?? '').trim();
  if (t.startsWith('Literal[')) return 'string';
  const lowered = t.toLowerCase();
  if (lowered.startsWith('str') || lowered === 'string') return 'string';
  if (lowered.startsWith('int') || lowered.startsWith('bool') === false && /^int/.test(lowered)) return 'integer';
  if (lowered.startsWith('float') || lowered.startsWith('decimal') || lowered.startsWith('double')) return 'number';
  if (lowered.startsWith('bool')) return 'boolean';
  if (lowered.startsWith('list') || lowered.startsWith('sequence') || lowered.startsWith('tuple') || lowered.startsWith('set'))
    return 'array';
  if (lowered.startsWith('dict') || lowered.startsWith('mapping')) return 'object';
  if (!t) return 'string'; // clean_properties: fix missing type
  return 'string';
}

export type ToolSpecParameter = {
  name: string;
  description?: string;
  type: string;
};

export type ToolSpec = {
  name: string;
  description: string;
  parameters: {
    title: string;
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
};

/**
 * Static port of utils/tools.py get_tool_specs: build the OpenAI function
 * specs for every public method of `class Tools:` (docstring → description,
 * signature → parameters). `file_handler` / `citation` flags are surfaced
 * separately via getToolMetaFlags.
 */
export function getToolSpecsFromSource(content: string): ToolSpec[] {
  const classes = extractTopLevelClasses(replaceImports(content));
  const toolsClass = classes.get('Tools');
  if (!toolsClass) return [];
  const specs: ToolSpec[] = [];
  for (const method of parseClassMethods(toolsClass)) {
    if (method.name.startsWith('_') || method.name === 'valves') continue;
    const paramDocs = parseDocstringParams(method.docstring);
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const arg of method.args) {
      const prop: Record<string, any> = { title: titleCase(arg.name) };
      prop.type = annotationToType(arg.annotation);
      const desc = paramDocs[arg.name];
      if (desc) prop.description = desc;
      if (arg.default !== undefined) {
        const parsed = parsePythonLiteral(arg.default);
        if (parsed !== null && parsed !== undefined) prop.default = parsed;
      }
      properties[arg.name] = prop;
      if (arg.default === undefined) required.push(arg.name);
    }
    const description = parseDescription(method.docstring).trim() || method.name;
    const spec: ToolSpec = {
      name: method.name,
      description,
      parameters: {
        title: titleCase(method.name),
        type: 'object',
        properties,
      },
    };
    if (required.length) spec.parameters.required = required;
    specs.push(spec);
  }
  return specs;
}

/** Detect file_handler / citation capability flags from the source. */
export function getToolMetaFlags(content: string): { file_handler: boolean; citation: boolean } {
  const classes = extractTopLevelClasses(replaceImports(content));
  const moduleAssignments = extractModuleLevelAssignments(content);
  const toolsClass = classes.get('Tools');
  const classAssignments = toolsClass ? extractClassAssignments(toolsClass) : {};
  const truthy = (v: any) => v === true || v === 1 || (typeof v === 'string' && ['true', 'True'].includes(v));
  return {
    file_handler: truthy(moduleAssignments.file_handler) || truthy(classAssignments.file_handler),
    citation: truthy(moduleAssignments.citation) || truthy(classAssignments.citation),
  };
}

/** True when the source declares a module-level `class UserValves`. */
export function sourceHasUserValves(content: string): boolean {
  return extractTopLevelClasses(content).has('UserValves');
}

export type ValvesSchema = {
  title: string;
  type: 'object';
  properties: Record<string, any>;
  required?: string[];
};

/**
 * Static port of `Valves.schema()` — build the pydantic JSON schema for the
 * module-level `class <Name>(BaseModel)` from its attribute definitions
 * (`Field(default=..., description=..., json_schema_extra=...)` aware).
 * Returns null when the class is absent.
 */
export function getValvesSchema(content: string, className: 'Valves' | 'UserValves'): ValvesSchema | null {
  const classes = extractTopLevelClasses(replaceImports(content));
  const body = classes.get(className);
  if (!body) return null;
  const properties: Record<string, any> = {};
  const required: string[] = [];
  for (const line of body.lines) {
    if (/^\s*(def|class|@|\w+\s*\()/.test(line)) {
      if (!/^\s*[A-Za-z_]\w*\s*(?::[^=]+)?=\s*Field\s*\(/.test(line)) continue;
    }
    const m = line.match(/^([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*=\s*(.+?)\s*$/);
    if (!m) {
      const plain = line.match(/^([A-Za-z_]\w*)\s*:\s*([^=]+?)\s*$/);
      if (plain) {
        // annotation-only attribute → required
        const prop: Record<string, any> = { title: titleCase(plain[1]), type: annotationToType(plain[2].trim()) };
        properties[plain[1]] = prop;
        required.push(plain[1]);
      }
      continue;
    }
    const [, name, annotation, value] = m;
    const prop: Record<string, any> = { title: titleCase(name) };
    if (annotation) prop.type = annotationToType(annotation.trim());
    const isField = /^Field\s*\(/.test(value);
    if (isField) {
      const kwargs = parseFieldKwargs(value);
      if (kwargs.description !== undefined) prop.description = String(kwargs.description);
      if (kwargs.default !== undefined && kwargs.default !== null) prop.default = kwargs.default;
      if (kwargs.default === null) {
        /* null default dropped (clean_properties) */
      }
      if (kwargs.input !== undefined) prop.input = kwargs.input;
      if (kwargs.default === undefined && !('default' in kwargs)) required.push(name);
    } else {
      const parsed = parsePythonLiteral(value);
      if (parsed === null) {
        /* null default dropped */
      } else if (parsed !== undefined) {
        prop.default = parsed;
      } else {
        required.push(name);
      }
      if (!annotation) prop.type = 'string';
    }
    if (!prop.type) prop.type = 'string';
    properties[name] = prop;
  }
  const schema: ValvesSchema = { title: className, type: 'object', properties };
  if (required.length) schema.required = required;
  return schema;
}

/** Parse `Field(default=..., description=..., json_schema_extra={...})` kwargs. */
function parseFieldKwargs(fieldExpr: string): Record<string, any> {
  const inner = fieldExpr.slice(fieldExpr.indexOf('(') + 1, fieldExpr.lastIndexOf(')'));
  const out: Record<string, any> = {};
  for (const part of splitArgs(inner)) {
    const m = part.match(/^(\w+)\s*=\s*(.+)$/s);
    if (!m) continue;
    const key = m[1];
    if (key === 'description') {
      const parsed = parsePythonLiteral(m[2]);
      if (parsed !== undefined) out.description = parsed;
    } else if (key === 'default') {
      const parsed = parsePythonLiteral(m[2]);
      if (parsed !== undefined) out.default = parsed;
    } else if (key === 'default_factory') {
      out.default_factory = true;
    } else if (key === 'json_schema_extra') {
      const parsed = parsePythonLiteral(m[2]);
      if (parsed && typeof parsed === 'object') {
        if (parsed.input !== undefined) out.input = parsed.input;
      }
    }
  }
  return out;
}

/**
 * Resolve dynamic select options in a valves schema. Python can call methods
 * named by `options`; the static parser keeps list options as-is and leaves
 * string options untouched (documented deviation).
 */
export function resolveValvesSchemaOptions(schema: ValvesSchema | null): ValvesSchema | null {
  return schema;
}

/** Static port of load_function_module_by_id type detection. */
export function getFunctionTypeFromSource(content: string): 'pipe' | 'filter' | 'action' | 'event' | null {
  const classes = extractTopLevelClasses(replaceImports(content));
  if (classes.has('Pipe')) return 'pipe';
  if (classes.has('Filter')) return 'filter';
  if (classes.has('Action')) return 'action';
  if (classes.has('Event')) return 'event';
  return null;
}

/** `toggle` flag for filter functions (module- or class-level assignment). */
export function getFunctionToggleFromSource(content: string): boolean {
  const type = getFunctionTypeFromSource(content);
  if (type !== 'filter') return false;
  const classes = extractTopLevelClasses(replaceImports(content));
  const moduleAssignments = extractModuleLevelAssignments(content);
  if (moduleAssignments.toggle !== undefined) return Boolean(moduleAssignments.toggle);
  for (const [, body] of classes) {
    const assignments = extractClassAssignments(body);
    if (assignments.toggle !== undefined) return Boolean(assignments.toggle);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Unified line diff (difflib.unified_diff port, n=3 context)
// ---------------------------------------------------------------------------

export function unifiedDiff(oldText: string, newText: string, fromFile: string, toFile: string): string {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  // LCS table
  const n = a.length;
  const m = b.length;
  // Guard against pathological sizes
  if (n * m > 4_000_000) {
    return ['', `--- ${fromFile}`, `+++ ${toFile}`, '@@ -1,1 +1,1 @@', ...a.map((l) => ` ${l}`), ...b.map((l) => `+${l}`)]
      .filter((l, i) => i > 3)
      .join('\n');
  }
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  type Op = { kind: ' ' | '-' | '+'; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: '-', line: a[i] });
      i++;
    } else {
      ops.push({ kind: '+', line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: '-', line: a[i++] });
  while (j < m) ops.push({ kind: '+', line: b[j++] });

  // Build hunks with 3 lines of context
  const lines: string[] = [`--- ${fromFile}`, `+++ ${toFile}`];
  const CONTEXT = 3;
  let idx = 0;
  while (idx < ops.length) {
    if (ops[idx].kind === ' ') {
      idx++;
      continue;
    }
    // hunk start at first change
    const start = Math.max(0, idx - CONTEXT);
    let end = idx;
    while (end < ops.length) {
      if (ops[end].kind !== ' ') {
        end += CONTEXT + 1;
        // extend through subsequent changes
        while (end < ops.length && ops[end].kind !== ' ') end++;
      } else {
        // look ahead: change within context → extend
        let lookahead = end;
        let gap = 0;
        while (lookahead < ops.length && ops[lookahead].kind === ' ' && gap <= CONTEXT) {
          lookahead++;
          gap++;
        }
        if (lookahead < ops.length && ops[lookahead].kind !== ' ' && gap <= CONTEXT) {
          end = lookahead;
        } else break;
      }
    }
    const hunkOps = ops.slice(start, end);
    // count old/new lines in hunk
    let oldCount = 0;
    let newCount = 0;
    for (const op of hunkOps) {
      if (op.kind === ' ' || op.kind === '-') oldCount++;
      if (op.kind === ' ' || op.kind === '+') newCount++;
    }
    let oldStart = 1;
    let newStart = 1;
    {
      let o = 0;
      let nw = 0;
      for (let k = 0; k < start; k++) {
        if (ops[k].kind === ' ' || ops[k].kind === '-') o++;
        if (ops[k].kind === ' ' || ops[k].kind === '+') nw++;
      }
      oldStart = o + 1;
      newStart = nw + 1;
    }
    const oldRange = oldCount === 0 ? `${oldStart - 1},0` : oldCount === 1 ? `${oldStart}` : `${oldStart},${oldCount}`;
    const newRange = newCount === 0 ? `${newStart - 1},0` : newCount === 1 ? `${newStart}` : `${newStart},${newCount}`;
    lines.push(`@@ -${oldRange} +${newRange} @@`);
    for (const op of hunkOps) lines.push(`${op.kind}${op.line}`);
    idx = end;
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tools table (models/tools.py)
// ---------------------------------------------------------------------------

export type ToolMeta = {
  description?: string | null;
  manifest?: Record<string, any>;
  has_user_valves?: boolean;
  [key: string]: any;
};

export type ToolModel = {
  version_id: string | null;
  id: string;
  user_id: string | null;
  name: string;
  content: string | null;
  specs: any[];
  meta: ToolMeta;
  access_grants: AccessGrantModel[];
  updated_at: number;
  created_at: number;
};

function toolRowToModel(
  row: {
    id: string;
    version_id: string | null;
    user_id: string | null;
    name: string | null;
    content: string | null;
    specs: string | null;
    meta: string | null;
    updated_at: number;
    created_at: number | null;
  },
  grants: AccessGrantModel[]
): ToolModel {
  return {
    version_id: row.version_id ?? null,
    id: row.id,
    user_id: row.user_id ?? null,
    name: row.name ?? '',
    content: row.content ?? null,
    specs: safeParse<any[]>(row.specs, []),
    meta: safeParse<ToolMeta>(row.meta, {}) ?? {},
    access_grants: grants,
    updated_at: row.updated_at,
    created_at: row.created_at ?? 0,
  };
}

export async function getToolById(id: string): Promise<ToolModel | null> {
  const row = await db.tool.findUnique({ where: { id } });
  if (!row) return null;
  const grants = await getGrantsByResource('tool', id);
  return toolRowToModel(row, grants);
}

export async function getTools(opts: { deferContent?: boolean; userId?: string | null; userGroupIds?: string[]; permission?: 'read' | 'write' } = {}): Promise<ToolModel[]> {
  const { deferContent = false, userId = null, userGroupIds, permission = 'read' } = opts;
  const rows = await db.tool.findMany({ orderBy: { updated_at: 'desc' } });
  let filtered = rows;
  if (userId !== null) {
    const groups = userGroupIds ?? (await getUserGroupIds(userId));
    const accessible = await getAccessibleResourceIds(userId, 'tool', rows.map((r) => r.id), permission, groups);
    filtered = rows.filter((r) => r.user_id === userId || accessible.has(r.id));
  }
  const grantsMap = await getGrantsByResources('tool', filtered.map((r) => r.id));
  const models = filtered.map((row) => toolRowToModel(row, grantsMap[row.id] ?? []));
  if (deferContent) {
    for (const model of models) model.content = null;
  }
  return models;
}

/** Python tool_snapshot — canonical snapshot for history comparisons. */
export function toolSnapshot(resource: { name: any; content: any; meta: any }): Record<string, any> {
  const meta = resource.meta ? structuredClone(resource.meta) : {};
  meta['description'] = meta['description'] ?? null;
  if (!meta['i18n']) delete meta['i18n'];
  delete meta['manifest'];
  delete meta['has_user_valves'];
  return { name: resource.name, content: resource.content ?? '', meta };
}

async function createToolHistoryEntry(
  toolId: string,
  snapshot: Record<string, any>,
  userId: string,
  parentId: string | null,
  commitMessage: string | null
): Promise<string> {
  const id = uuid();
  await db.toolHistory.create({
    data: {
      id,
      tool_id: toolId,
      parent_id: parentId,
      snapshot: JSON.stringify(snapshot),
      user_id: userId,
      commit_message: commitMessage,
      created_at: nowSec(),
    },
  });
  return id;
}

export type ToolHistoryEntry = {
  id: string;
  tool_id: string;
  parent_id: string | null;
  user_id: string;
  commit_message: string | null;
  created_at: number;
  user: { name: string } | null;
  snapshot?: Record<string, any>;
};

async function toolHistoryWithAuthor(row: {
  id: string;
  tool_id: string;
  parent_id: string | null;
  user_id: string;
  commit_message: string | null;
  created_at: number;
  snapshot: string;
}): Promise<ToolHistoryEntry> {
  const author = await db.user.findUnique({ where: { id: row.user_id }, select: { name: true } });
  return {
    id: row.id,
    tool_id: row.tool_id,
    parent_id: row.parent_id,
    user_id: row.user_id,
    commit_message: row.commit_message,
    created_at: row.created_at,
    user: author ? { name: author.name } : null,
    snapshot: safeParse<Record<string, any>>(row.snapshot, {}),
  };
}

export async function getToolHistoryByToolId(toolId: string, page = 1): Promise<ToolHistoryEntry[]> {
  const p = Math.max(1, page);
  const rows = await db.toolHistory.findMany({
    where: { tool_id: toolId },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    skip: (p - 1) * 20,
    take: 20,
  });
  const out: ToolHistoryEntry[] = [];
  for (const row of rows) {
    const author = await db.user.findUnique({ where: { id: row.user_id }, select: { name: true } });
    out.push({
      id: row.id,
      tool_id: row.tool_id,
      parent_id: row.parent_id,
      user_id: row.user_id,
      commit_message: row.commit_message,
      created_at: row.created_at,
      user: author ? { name: author.name } : null,
    });
  }
  return out;
}

export async function getToolHistoryById(toolId: string, historyId: string): Promise<ToolHistoryEntry | null> {
  const row = await db.toolHistory.findFirst({ where: { tool_id: toolId, id: historyId } });
  if (!row) return null;
  return toolHistoryWithAuthor(row);
}

export async function deleteToolHistoryEntry(toolId: string, historyId: string): Promise<boolean> {
  const tool = await db.tool.findUnique({ where: { id: toolId } });
  if (!tool) return false;
  if (tool.version_id === historyId) {
    throw new HttpError(400, 'Cannot delete the current version');
  }
  const entry = await db.toolHistory.findFirst({ where: { id: historyId, tool_id: toolId } });
  if (!entry) return false;
  await db.toolHistory.updateMany({
    where: { tool_id: toolId, parent_id: historyId },
    data: { parent_id: entry.parent_id },
  });
  await db.toolHistory.delete({ where: { id: historyId } });
  return true;
}

export function toolDiff(
  before: { id: string; snapshot: Record<string, any> },
  after: { id: string; snapshot: Record<string, any> }
): Record<string, any> {
  const left = before.snapshot;
  const right = after.snapshot;
  const metadata: Record<string, any> = {};
  for (const key of ['name', 'meta']) {
    if (!deepEqual(left[key], right[key])) {
      metadata[key] = { before: left[key] ?? null, after: right[key] ?? null };
    }
  }
  const oldText = left['content'] ?? '';
  const newText = right['content'] ?? '';
  const patch = unifiedDiff(oldText, newText, 'selected.py', 'production.py');
  return {
    from_id: before.id,
    to_id: after.id,
    metadata,
    content_diff: patch,
    line_endings_only: oldText !== newText && !patch,
  };
}

export type ToolWriteResult = { tool: ToolModel };

/**
 * Python ToolsTable._write_tool + insert/update. `updated` is a partial column
 * map (name/content/specs/meta/valves...); history entries are created when the
 * snapshot changes.
 */
async function writeTool(
  existing: { id: string; version_id: string | null; user_id: string | null; name: string | null; content: string | null; meta: string | null; valves: string | null } | null,
  updated: Record<string, any>,
  userId: string | null,
  versionId: string | null,
  commitMessage: string | null
): Promise<string> {
  const row = existing ?? {
    id: updated.id,
    version_id: null as string | null,
    user_id: userId,
    name: (updated.name as string) ?? null,
    content: (updated.content as string) ?? null,
    meta: JSON.stringify(updated.meta ?? {}),
    valves: null as string | null,
  };
  const currentMeta = safeParse<Record<string, any>>(row.meta, {}) ?? {};
  const before = toolSnapshot({ name: row.name, content: row.content, meta: currentMeta });
  if (versionId) {
    const entry = await db.toolHistory.findFirst({ where: { id: versionId, tool_id: row.id } });
    if (!entry) throw new HttpError(404, 'Version not found');
    const candidate = toolSnapshot({
      name: 'name' in updated ? updated.name : row.name,
      content: 'content' in updated ? updated.content : row.content,
      meta: 'meta' in updated ? updated.meta : currentMeta,
    });
    if (!deepEqual(candidate, safeParse<Record<string, any>>(entry.snapshot, {}))) {
      throw new HttpError(400, 'Version configuration does not match the saved snapshot');
    }
  }
  const nextName = 'name' in updated ? updated.name : row.name;
  const nextContent = 'content' in updated ? updated.content : row.content;
  const nextMeta = 'meta' in updated ? updated.meta : currentMeta;
  const after = toolSnapshot({ name: nextName, content: nextContent, meta: nextMeta });
  let nextVersionId: string = row.version_id ?? '';
  if (versionId) {
    nextVersionId = versionId;
  } else if (!deepEqual(after, before) || !row.version_id) {
    nextVersionId = await createToolHistoryEntry(
      row.id,
      after,
      userId ?? row.user_id ?? '',
      row.version_id ?? '',
      commitMessage ?? null
    );
  }
  return nextVersionId;
}

export async function insertNewTool(
  userId: string,
  form: {
    id: string;
    name: string;
    content: string;
    meta: Record<string, any>;
    access_grants?: any[] | null;
    commit_message?: string | null;
  },
  specs: any[]
): Promise<ToolModel | null> {
  const now = nowSec();
  try {
    const versionId = await writeTool(null, { ...form, specs }, userId, null, form.commit_message ?? null);
    await db.tool.create({
      data: {
        id: form.id,
        version_id: versionId,
        user_id: userId,
        name: form.name,
        content: form.content,
        specs: JSON.stringify(specs),
        meta: JSON.stringify(form.meta ?? {}),
        updated_at: now,
        created_at: now,
      },
    });
    await setAccessGrants('tool', form.id, form.access_grants ?? null);
    return await getToolById(form.id);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error('Error creating tool', e);
    return null;
  }
}

export async function updateToolById(
  id: string,
  updated: Record<string, any>,
  userId: string,
  versionId: string | null = null
): Promise<ToolModel | null> {
  const existing = await db.tool.findUnique({ where: { id } });
  if (!existing) throw new HttpError(400, 'Tool not found');
  const commitMessage = updated.commit_message ?? null;
  const nextVersionId = await writeTool(existing, updated, userId, versionId, commitMessage);
  await db.tool.update({
    where: { id },
    data: {
      ...(updated.name !== undefined ? { name: updated.name } : {}),
      ...(updated.content !== undefined ? { content: updated.content } : {}),
      ...(updated.specs !== undefined ? { specs: JSON.stringify(updated.specs) } : {}),
      ...(updated.meta !== undefined ? { meta: JSON.stringify(updated.meta ?? {}) } : {}),
      version_id: nextVersionId,
      updated_at: nowSec(),
    },
  });
  return await getToolById(id);
}

export async function deleteToolById(id: string): Promise<boolean> {
  await db.accessGrant.deleteMany({ where: { resource_type: 'tool', resource_id: id } });
  await db.toolHistory.deleteMany({ where: { tool_id: id } });
  await db.tool.delete({ where: { id } });
  return true;
}

export async function getToolValvesById(id: string): Promise<Record<string, any> | null> {
  const row = await db.tool.findUnique({ where: { id }, select: { valves: true } });
  return decryptValves(row?.valves ?? null);
}

export async function updateToolValvesById(id: string, valves: Record<string, any>): Promise<void> {
  await db.tool.update({
    where: { id },
    data: { valves: encryptValves(valves), updated_at: nowSec() },
  });
}

export async function getUserValvesForTool(id: string, userId: string): Promise<Record<string, any> | null> {
  const settings = await getUserSettings(userId);
  settings.tools ??= {};
  settings.tools.valves ??= {};
  return decryptValves(settings.tools.valves[id] ?? null);
}

export async function updateUserValvesForTool(
  id: string,
  userId: string,
  valves: Record<string, any>
): Promise<Record<string, any> | null> {
  try {
    const settings = await getUserSettings(userId);
    settings.tools ??= {};
    settings.tools.valves ??= {};
    settings.tools.valves[id] = encryptValves(valves);
    await updateUserSettings(userId, settings);
    return valves;
  } catch (e) {
    console.error(`Error updating user valves by id ${id} and user_id ${userId}: ${e}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Functions table (models/functions.py)
// ---------------------------------------------------------------------------

export type FunctionMeta = {
  description?: string | null;
  manifest?: Record<string, any>;
  toggle?: boolean;
  [key: string]: any;
};

export type FunctionModel = {
  version_id: string | null;
  id: string;
  user_id: string | null;
  name: string;
  type: string;
  content: string | null;
  meta: FunctionMeta;
  is_active: boolean;
  is_global: boolean;
  updated_at: number;
  created_at: number;
};

function functionRowToModel(row: {
  id: string;
  version_id: string | null;
  user_id: string | null;
  name: string;
  type: string;
  content: string | null;
  meta: string | null;
  is_active: boolean | null;
  is_global: boolean | null;
  updated_at: number | null;
  created_at: number | null;
}): FunctionModel {
  return {
    version_id: row.version_id ?? null,
    id: row.id,
    user_id: row.user_id ?? null,
    name: row.name,
    type: row.type,
    content: row.content ?? '',
    meta: safeParse<FunctionMeta>(row.meta, {}) ?? {},
    is_active: row.is_active ?? false,
    is_global: row.is_global ?? false,
    updated_at: row.updated_at ?? 0,
    created_at: row.created_at ?? 0,
  };
}

export async function getFunctionById(id: string): Promise<FunctionModel | null> {
  const row = await db.function.findUnique({ where: { id } });
  return row ? functionRowToModel(row) : null;
}

export async function getFunctions(opts: { activeOnly?: boolean; includeValves?: boolean } = {}): Promise<any[]> {
  const rows = opts.activeOnly
    ? await db.function.findMany({ where: { is_active: true } })
    : await db.function.findMany();
  return rows.map((row) => {
    const model: any = functionRowToModel(row);
    if (opts.includeValves) model.valves = decryptValves(row.valves);
    return model;
  });
}

export async function getFunctionList(): Promise<any[]> {
  const rows = await db.function.findMany({ orderBy: { updated_at: 'desc' } });
  const userIds = [...new Set(rows.map((r) => r.user_id).filter((u): u is string => !!u))];
  const users = await getUsersByIds(userIds);
  const usersById = new Map(users.map((u) => [u.id, u]));
  return rows.map((row) => {
    const model = functionRowToModel(row);
    const user = row.user_id ? usersById.get(row.user_id) : undefined;
    return { ...model, user: toUserResponse(user ?? ({} as any)) };
  });
}

/** Python function_snapshot. */
export function functionSnapshot(resource: { name: any; content: any; meta: any }): Record<string, any> {
  const meta = resource.meta ? structuredClone(resource.meta) : {};
  meta['description'] = meta['description'] ?? null;
  if (!meta['i18n']) delete meta['i18n'];
  delete meta['manifest'];
  delete meta['has_user_valves'];
  delete meta['toggle'];
  return { name: resource.name, content: resource.content ?? '', meta };
}

async function createFunctionHistoryEntry(
  functionId: string,
  snapshot: Record<string, any>,
  userId: string,
  parentId: string | null,
  commitMessage: string | null
): Promise<string> {
  const id = uuid();
  await db.functionHistory.create({
    data: {
      id,
      function_id: functionId,
      parent_id: parentId,
      snapshot: JSON.stringify(snapshot),
      user_id: userId,
      commit_message: commitMessage,
      created_at: nowSec(),
    },
  });
  return id;
}

export async function getFunctionHistoryByFunctionId(functionId: string, page = 1): Promise<any[]> {
  const p = Math.max(1, page);
  const rows = await db.functionHistory.findMany({
    where: { function_id: functionId },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    skip: (p - 1) * 20,
    take: 20,
  });
  const out: any[] = [];
  for (const row of rows) {
    const author = await db.user.findUnique({ where: { id: row.user_id }, select: { name: true } });
    out.push({
      id: row.id,
      function_id: row.function_id,
      parent_id: row.parent_id,
      user_id: row.user_id,
      commit_message: row.commit_message,
      created_at: row.created_at,
      user: author ? { name: author.name } : null,
    });
  }
  return out;
}

export async function getFunctionHistoryById(functionId: string, historyId: string): Promise<any | null> {
  const row = await db.functionHistory.findFirst({ where: { function_id: functionId, id: historyId } });
  if (!row) return null;
  const author = await db.user.findUnique({ where: { id: row.user_id }, select: { name: true } });
  return {
    id: row.id,
    function_id: row.function_id,
    parent_id: row.parent_id,
    user_id: row.user_id,
    commit_message: row.commit_message,
    created_at: row.created_at,
    user: author ? { name: author.name } : null,
    snapshot: safeParse<Record<string, any>>(row.snapshot, {}),
  };
}

export async function deleteFunctionHistoryEntry(functionId: string, historyId: string): Promise<boolean> {
  const fn = await db.function.findUnique({ where: { id: functionId } });
  if (!fn) return false;
  if (fn.version_id === historyId) throw new HttpError(400, 'Cannot delete the current version');
  const entry = await db.functionHistory.findFirst({ where: { id: historyId, function_id: functionId } });
  if (!entry) return false;
  await db.functionHistory.updateMany({
    where: { function_id: functionId, parent_id: historyId },
    data: { parent_id: entry.parent_id },
  });
  await db.functionHistory.delete({ where: { id: historyId } });
  return true;
}

export function functionDiff(
  before: { id: string; snapshot: Record<string, any> },
  after: { id: string; snapshot: Record<string, any> }
): Record<string, any> {
  const left = before.snapshot;
  const right = after.snapshot;
  const metadata: Record<string, any> = {};
  for (const key of ['name', 'meta']) {
    if (!deepEqual(left[key], right[key])) {
      metadata[key] = { before: left[key] ?? null, after: right[key] ?? null };
    }
  }
  const oldText = left['content'] ?? '';
  const newText = right['content'] ?? '';
  const patch = unifiedDiff(oldText, newText, 'selected.py', 'production.py');
  return {
    from_id: before.id,
    to_id: after.id,
    metadata,
    content_diff: patch,
    line_endings_only: oldText !== newText && !patch,
  };
}

export async function insertNewFunction(
  userId: string,
  type: string,
  form: { id: string; name: string; content: string; meta: Record<string, any>; commit_message?: string | null }
): Promise<FunctionModel | null> {
  const now = nowSec();
  try {
    const snapshot = functionSnapshot({ name: form.name, content: form.content, meta: form.meta ?? {} });
    const versionId = await createFunctionHistoryEntry(form.id, snapshot, userId, null, form.commit_message ?? null);
    await db.function.create({
      data: {
        id: form.id,
        version_id: versionId,
        user_id: userId,
        name: form.name,
        type,
        content: form.content,
        meta: JSON.stringify(form.meta ?? {}),
        is_active: false,
        is_global: false,
        updated_at: now,
        created_at: now,
      },
    });
    return await getFunctionById(form.id);
  } catch (e) {
    console.error('Error creating function', e);
    return null;
  }
}

export async function updateFunctionById(
  id: string,
  updated: Record<string, any>,
  userId: string,
  versionId: string | null = null
): Promise<FunctionModel | null> {
  const existing = await db.function.findUnique({ where: { id } });
  if (!existing) throw new HttpError(400, 'Function not found');
  const currentMeta = safeParse<Record<string, any>>(existing.meta, {}) ?? {};
  const commitMessage = updated.commit_message ?? null;
  const before = functionSnapshot({ name: existing.name, content: existing.content, meta: currentMeta });
  if (versionId) {
    const entry = await db.functionHistory.findFirst({ where: { id: versionId, function_id: id } });
    if (!entry) throw new HttpError(404, 'Version not found');
    const candidate = functionSnapshot({
      name: 'name' in updated ? updated.name : existing.name,
      content: 'content' in updated ? updated.content : existing.content,
      meta: 'meta' in updated ? updated.meta : currentMeta,
    });
    if (!deepEqual(candidate, safeParse<Record<string, any>>(entry.snapshot, {}))) {
      throw new HttpError(400, 'Version configuration does not match the saved snapshot');
    }
  }
  const nextName = updated.name !== undefined ? updated.name : existing.name;
  const nextContent = updated.content !== undefined ? updated.content : existing.content;
  const nextMeta = updated.meta !== undefined ? updated.meta : currentMeta;
  const after = functionSnapshot({ name: nextName, content: nextContent, meta: nextMeta });
  let nextVersionId = existing.version_id;
  if (versionId) {
    nextVersionId = versionId;
  } else if (!deepEqual(after, before) || !existing.version_id) {
    nextVersionId = await createFunctionHistoryEntry(id, after, userId, existing.version_id, commitMessage);
  }
  await db.function.update({
    where: { id },
    data: {
      ...(updated.name !== undefined ? { name: updated.name } : {}),
      ...(updated.type !== undefined ? { type: updated.type } : {}),
      ...(updated.content !== undefined ? { content: updated.content } : {}),
      ...(updated.meta !== undefined ? { meta: JSON.stringify(updated.meta ?? {}) } : {}),
      ...(updated.is_active !== undefined ? { is_active: updated.is_active } : {}),
      ...(updated.is_global !== undefined ? { is_global: updated.is_global } : {}),
      ...(updated.valves !== undefined ? { valves: encryptValves(updated.valves) } : {}),
      version_id: nextVersionId,
      updated_at: nowSec(),
    },
  });
  return await getFunctionById(id);
}

export async function deleteFunctionById(id: string): Promise<boolean> {
  await db.functionHistory.deleteMany({ where: { function_id: id } });
  await db.function.delete({ where: { id } });
  return true;
}

export async function getFunctionValvesById(id: string): Promise<Record<string, any> | null> {
  const row = await db.function.findUnique({ where: { id }, select: { valves: true } });
  return decryptValves(row?.valves ?? null);
}

export async function updateFunctionValvesById(id: string, valves: Record<string, any>): Promise<void> {
  await db.function.update({
    where: { id },
    data: { valves: encryptValves(valves), updated_at: nowSec() },
  });
}

export async function getUserValvesForFunction(id: string, userId: string): Promise<Record<string, any> | null> {
  const settings = await getUserSettings(userId);
  settings.functions ??= {};
  settings.functions.valves ??= {};
  return decryptValves(settings.functions.valves[id] ?? null);
}

export async function updateUserValvesForFunction(
  id: string,
  userId: string,
  valves: Record<string, any>
): Promise<Record<string, any> | null> {
  try {
    const settings = await getUserSettings(userId);
    settings.functions ??= {};
    settings.functions.valves ??= {};
    settings.functions.valves[id] = encryptValves(valves);
    await updateUserSettings(userId, settings);
    return valves;
  } catch (e) {
    console.error(`Error updating user valves by id ${id} and user_id ${userId}: ${e}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prompts table (models/prompts.py)
// ---------------------------------------------------------------------------

export type PromptModel = {
  id: string | null;
  command: string;
  user_id: string;
  name: string;
  content: string;
  data: Record<string, any> | null;
  meta: Record<string, any> | null;
  tags: string[] | null;
  is_active: boolean | null;
  version_id: string | null;
  created_at: number | null;
  updated_at: number | null;
  access_grants: AccessGrantModel[];
};

function promptRowToModel(
  row: {
    id: string;
    command: string | null;
    user_id: string | null;
    name: string | null;
    content: string | null;
    data: string | null;
    meta: string | null;
    tags: string | null;
    is_active: boolean | null;
    version_id: string | null;
    created_at: number | null;
    updated_at: number | null;
  },
  grants: AccessGrantModel[]
): PromptModel {
  return {
    id: row.id,
    command: row.command ?? '',
    user_id: row.user_id ?? '',
    name: row.name ?? '',
    content: row.content ?? '',
    data: safeParse<Record<string, any> | null>(row.data, null),
    meta: safeParse<Record<string, any> | null>(row.meta, null),
    tags: safeParse<string[] | null>(row.tags, null),
    is_active: row.is_active ?? true,
    version_id: row.version_id ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    access_grants: grants,
  };
}

export async function getPromptById(id: string): Promise<PromptModel | null> {
  const row = await db.prompt.findFirst({ where: { id } });
  if (!row) return null;
  const grants = await getGrantsByResource('prompt', row.id);
  return promptRowToModel(row, grants);
}

export async function getPromptByCommand(command: string): Promise<PromptModel | null> {
  const row = await db.prompt.findFirst({ where: { command } });
  if (!row) return null;
  const grants = await getGrantsByResource('prompt', row.id);
  return promptRowToModel(row, grants);
}

function promptAccessFilter<T extends { id: string; user_id: string | null }>(
  rows: T[],
  userId: string,
  groups: string[],
  permission: 'read' | 'write',
  accessible: Set<string>
): T[] {
  void groups;
  void permission;
  return rows.filter((row) => row.user_id === userId || accessible.has(row.id));
}

export async function getPrompts(opts: { userId?: string | null; userGroupIds?: string[]; permission?: 'read' | 'write' } = {}): Promise<PromptModel[]> {
  const { userId = null, userGroupIds, permission = 'read' } = opts;
  const rows = await db.prompt.findMany({
    where: { is_active: true },
    orderBy: { updated_at: 'desc' },
  });
  let filtered = rows;
  if (userId !== null) {
    const groups = userGroupIds ?? (await getUserGroupIds(userId));
    const accessible = await getAccessibleResourceIds(userId, 'prompt', rows.map((r) => r.id), permission, groups);
    filtered = promptAccessFilter(rows, userId, groups, permission, accessible);
  }
  const grantsMap = await getGrantsByResources('prompt', filtered.map((r) => r.id));
  return filtered.map((row) => promptRowToModel(row, grantsMap[row.id] ?? []));
}

export async function getPromptTags(opts: { userId?: string | null; userGroupIds?: string[] } = {}): Promise<string[]> {
  const { userId = null, userGroupIds } = opts;
  const rows = await db.prompt.findMany({ where: { is_active: true } });
  let filtered = rows;
  if (userId !== null) {
    const groups = userGroupIds ?? (await getUserGroupIds(userId));
    const accessible = await getAccessibleResourceIds(userId, 'prompt', rows.map((r) => r.id), 'read', groups);
    filtered = promptAccessFilter(rows, userId, groups, 'read', accessible);
  }
  const tags = new Set<string>();
  for (const row of filtered) {
    const list = safeParse<string[] | null>(row.tags, null);
    if (list) for (const tag of list) if (tag) tags.add(tag);
  }
  return [...tags].sort();
}

async function createPromptHistoryEntry(
  promptId: string,
  snapshot: Record<string, any>,
  userId: string,
  parentId: string | null,
  commitMessage: string | null
): Promise<string> {
  const id = uuid();
  await db.promptHistory.create({
    data: {
      id,
      prompt_id: promptId,
      parent_id: parentId,
      snapshot: JSON.stringify(snapshot),
      user_id: userId,
      commit_message: commitMessage,
      created_at: nowSec(),
    },
  });
  return id;
}

export async function getPromptLatestHistoryEntry(promptId: string): Promise<any | null> {
  const row = await db.promptHistory.findFirst({
    where: { prompt_id: promptId },
    orderBy: { created_at: 'desc' },
  });
  return row
    ? {
        id: row.id,
        prompt_id: row.prompt_id,
        parent_id: row.parent_id,
        snapshot: safeParse<Record<string, any>>(row.snapshot, {}),
        user_id: row.user_id,
        commit_message: row.commit_message,
        created_at: row.created_at,
      }
    : null;
}

export async function getPromptHistoryByPromptId(promptId: string, limit = 20, offset = 0): Promise<any[]> {
  const rows = await db.promptHistory.findMany({
    where: { prompt_id: promptId },
    orderBy: { created_at: 'desc' },
    skip: offset,
    take: limit,
  });
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const users = await getUsersByIds(userIds);
  const usersById = new Map(users.map((u) => [u.id, u]));
  return rows.map((row) => ({
    id: row.id,
    prompt_id: row.prompt_id,
    parent_id: row.parent_id,
    snapshot: safeParse<Record<string, any>>(row.snapshot, {}),
    user_id: row.user_id,
    commit_message: row.commit_message,
    created_at: row.created_at,
    user: usersById.get(row.user_id)
      ? toUserResponse(usersById.get(row.user_id) as any)
      : null,
  }));
}

export async function getPromptHistoryEntryById(historyId: string): Promise<any | null> {
  const row = await db.promptHistory.findFirst({ where: { id: historyId } });
  if (!row) return null;
  return {
    id: row.id,
    prompt_id: row.prompt_id,
    parent_id: row.parent_id,
    snapshot: safeParse<Record<string, any>>(row.snapshot, {}),
    user_id: row.user_id,
    commit_message: row.commit_message,
    created_at: row.created_at,
  };
}

export async function promptHistoryDiff(fromId: string, toId: string, promptId: string): Promise<Record<string, any> | null> {
  const fromRow = await db.promptHistory.findFirst({ where: { id: fromId, prompt_id: promptId } });
  const toRow = await db.promptHistory.findFirst({ where: { id: toId, prompt_id: promptId } });
  if (!fromRow || !toRow) return null;
  const fromSnapshot = safeParse<Record<string, any>>(fromRow.snapshot, {});
  const toSnapshot = safeParse<Record<string, any>>(toRow.snapshot, {});
  const fromContent = fromSnapshot['content'] ?? '';
  const toContent = toSnapshot['content'] ?? '';
  const diffLines = unifiedDiff(fromContent, toContent, `v${fromId.slice(0, 8)}`, `v${toId.slice(0, 8)}`)
    .split('\n');
  return {
    from_id: fromId,
    to_id: toId,
    from_snapshot: fromSnapshot,
    to_snapshot: toSnapshot,
    content_diff: diffLines,
    line_endings_only: diffLines.length === 0 && fromContent !== toContent,
    name_changed: fromSnapshot['name'] !== toSnapshot['name'],
  };
}

export async function deletePromptHistoryByPromptId(promptId: string): Promise<boolean> {
  await db.promptHistory.deleteMany({ where: { prompt_id: promptId } });
  return true;
}

export async function deletePromptHistoryEntry(historyId: string, promptId: string): Promise<boolean> {
  const entry = await db.promptHistory.findFirst({ where: { id: historyId, prompt_id: promptId } });
  if (!entry) return false;
  await db.promptHistory.updateMany({ where: { parent_id: historyId }, data: { parent_id: entry.parent_id } });
  await db.promptHistory.delete({ where: { id: historyId } });
  return true;
}

export async function insertNewPrompt(
  userId: string,
  form: {
    command: string;
    name: string;
    content: string;
    data?: Record<string, any> | null;
    meta?: Record<string, any> | null;
    tags?: string[] | null;
    access_grants?: any[] | null;
    commit_message?: string | null;
  }
): Promise<PromptModel | null> {
  const now = nowSec();
  const promptId = uuid();
  try {
    await db.prompt.create({
      data: {
        id: promptId,
        user_id: userId,
        command: form.command,
        name: form.name,
        content: form.content,
        data: JSON.stringify(form.data ?? {}),
        meta: JSON.stringify(form.meta ?? {}),
        tags: JSON.stringify(form.tags ?? []),
        is_active: true,
        created_at: now,
        updated_at: now,
      },
    });
    await setAccessGrants('prompt', promptId, form.access_grants ?? null);
    const grants = await getGrantsByResource('prompt', promptId);
    const snapshot = {
      name: form.name,
      content: form.content,
      command: form.command,
      data: form.data ?? {},
      meta: form.meta ?? {},
      tags: form.tags ?? [],
      access_grants: grants.map((g) => ({
        id: g.id,
        resource_type: g.resource_type,
        resource_id: g.resource_id,
        principal_type: g.principal_type,
        principal_id: g.principal_id,
        permission: g.permission,
        created_at: g.created_at,
      })),
    };
    const historyId = await createPromptHistoryEntry(promptId, snapshot, userId, null, form.commit_message || 'Initial version');
    await db.prompt.update({ where: { id: promptId }, data: { version_id: historyId } });
    return await getPromptById(promptId);
  } catch (e) {
    console.error('Error creating prompt', e);
    return null;
  }
}

export async function updatePromptById(
  promptId: string,
  form: {
    command: string;
    name: string;
    content: string;
    data?: Record<string, any> | null;
    meta?: Record<string, any> | null;
    tags?: string[] | null;
    is_production?: boolean | null;
    commit_message?: string | null;
  },
  userId: string
): Promise<PromptModel | null> {
  const existing = await db.prompt.findFirst({ where: { id: promptId } });
  if (!existing) return null;
  const latest = await getPromptLatestHistoryEntry(promptId);
  const parentId = latest?.id ?? null;
  const currentGrants = await getGrantsByResource('prompt', promptId);
  const currentData = safeParse<Record<string, any>>(existing.data, {}) ?? {};
  const currentMeta = safeParse<Record<string, any>>(existing.meta, {}) ?? {};
  const currentTags = safeParse<string[]>(existing.tags, []) ?? [];

  const contentChanged =
    existing.name !== form.name ||
    existing.command !== form.command ||
    existing.content !== form.content ||
    (form.tags !== null && form.tags !== undefined && !deepEqual(currentTags, form.tags));

  const isProduction = form.is_production !== false;
  const nextCommand = form.command;
  const nextName = isProduction ? form.name : existing.name;
  const nextContent = isProduction ? form.content : existing.content;
  const nextData = isProduction ? form.data ?? currentData : currentData;
  const nextMeta = isProduction ? form.meta ?? currentMeta : currentMeta;
  const nextTags = isProduction && form.tags !== null && form.tags !== undefined ? form.tags : currentTags;

  await db.prompt.update({
    where: { id: promptId },
    data: {
      command: nextCommand,
      name: nextName,
      content: nextContent,
      data: JSON.stringify(nextData ?? {}),
      meta: JSON.stringify(nextMeta ?? {}),
      tags: JSON.stringify(nextTags ?? []),
      updated_at: nowSec(),
    },
  });

  if (contentChanged) {
    const snapshot = {
      name: form.name,
      content: form.content,
      command: nextCommand,
      data: form.data ?? {},
      meta: form.meta ?? {},
      tags: form.tags !== null && form.tags !== undefined ? form.tags : currentTags,
      access_grants: currentGrants.map((g) => ({
        id: g.id,
        resource_type: g.resource_type,
        resource_id: g.resource_id,
        principal_type: g.principal_type,
        principal_id: g.principal_id,
        permission: g.permission,
        created_at: g.created_at,
      })),
    };
    const historyId = await createPromptHistoryEntry(promptId, snapshot, userId, parentId, form.commit_message ?? null);
    if (isProduction) {
      await db.prompt.update({ where: { id: promptId }, data: { version_id: historyId } });
    }
  }
  return await getPromptById(promptId);
}

export async function updatePromptMetadata(
  promptId: string,
  name: string,
  command: string,
  tags: string[] | null
): Promise<PromptModel | null> {
  const existing = await db.prompt.findFirst({ where: { id: promptId } });
  if (!existing) return null;
  await db.prompt.update({
    where: { id: promptId },
    data: {
      name,
      command,
      ...(tags !== null && tags !== undefined ? { tags: JSON.stringify(tags) } : {}),
      updated_at: nowSec(),
    },
  });
  return await getPromptById(promptId);
}

export async function updatePromptVersion(promptId: string, versionId: string): Promise<PromptModel | null> {
  const existing = await db.prompt.findFirst({ where: { id: promptId } });
  if (!existing) return null;
  const entry = await getPromptHistoryEntryById(versionId);
  if (!entry || entry.prompt_id !== promptId) return null;
  const snapshot = entry.snapshot ?? {};
  const currentData = safeParse<Record<string, any>>(existing.data, {}) ?? {};
  const currentMeta = safeParse<Record<string, any>>(existing.meta, {}) ?? {};
  const currentTags = safeParse<string[]>(existing.tags, []) ?? [];
  await db.prompt.update({
    where: { id: promptId },
    data: {
      name: snapshot['name'] ?? existing.name ?? '',
      content: snapshot['content'] ?? existing.content ?? '',
      data: JSON.stringify(snapshot['data'] ?? currentData),
      meta: JSON.stringify(snapshot['meta'] ?? currentMeta),
      tags: JSON.stringify(snapshot['tags'] ?? currentTags),
      version_id: versionId,
      updated_at: nowSec(),
    },
  });
  return await getPromptById(promptId);
}

export async function togglePromptActive(promptId: string): Promise<PromptModel | null> {
  const existing = await db.prompt.findFirst({ where: { id: promptId } });
  if (!existing) return null;
  await db.prompt.update({
    where: { id: promptId },
    data: { is_active: !(existing.is_active ?? true), updated_at: nowSec() },
  });
  return await getPromptById(promptId);
}

export async function deletePromptById(promptId: string): Promise<boolean> {
  const existing = await db.prompt.findFirst({ where: { id: promptId } });
  if (!existing) return false;
  await deletePromptHistoryByPromptId(promptId);
  await revokeAllAccess('prompt', promptId);
  await db.prompt.delete({ where: { id: promptId } });
  return true;
}

// ---------------------------------------------------------------------------
// Notes pages helpers (models/notes.py — pure functions)
// ---------------------------------------------------------------------------

export class NotePageConflict extends Error {}

export type NotePage = {
  id: string;
  parent_id: string | null;
  title: string;
  content: Record<string, any>;
  versions: any[];
  revision: number;
  generation: number;
  inherit_note_title?: boolean;
  [key: string]: any;
};

export function orderPages(pages: NotePage[]): NotePage[] {
  const ids = new Set(pages.map((p) => p.id));
  if (ids.size !== pages.length) throw new Error('Page IDs must be unique');
  const children = new Map<string, NotePage[]>();
  for (const page of pages) {
    if (page.id === 'main') page.parent_id = null;
    else if (page.parent_id === undefined) page.parent_id = null;
    const parent = page.parent_id ?? null;
    if (parent !== null && !ids.has(parent)) throw new Error('Parent page no longer exists');
    const bucket = children.get(parent ?? '') ?? [];
    bucket.push(page);
    children.set(parent ?? '', bucket);
  }
  const ordered: NotePage[] = [];
  const roots = children.get('') ?? [];
  roots.sort((a, b) => (a.id !== 'main' ? 1 : 0) - (b.id !== 'main' ? 1 : 0));
  const stack = [...roots].reverse();
  while (stack.length) {
    const page = stack.pop() as NotePage;
    ordered.push(page);
    stack.push(...[...(children.get(page.id) ?? [])].reverse());
  }
  if (ordered.length !== pages.length) throw new Error('A page cannot be nested inside itself or its subpages');
  return ordered;
}

function subtreeIds(pages: NotePage[], pageId: string): Set<string> {
  const result = new Set<string>([pageId]);
  for (const page of pages) {
    if (result.has(page.parent_id ?? '')) result.add(page.id);
  }
  return result;
}

function pagePaths(pages: NotePage[]): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const page of pages) {
    const parentPath = paths[page.parent_id ?? ''];
    paths[page.id] = parentPath ? `${parentPath} / ${page.title}` : page.title;
  }
  return paths;
}

/** Collect file attachments from a note page content block tree. */
export function getContentFiles(content: Record<string, any> | null | undefined): Array<Record<string, any>> {
  if (!content || typeof content !== 'object') return [];
  const files: Record<string, Record<string, any>> = {};
  const document = content['json'];
  if (document && typeof document === 'object') {
    const stack: any[] = [document];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (node['type'] === 'fileAttachment') {
        const attrs = node['attrs'] ?? {};
        const fileId = attrs['id'];
        if (typeof fileId === 'string' && /^[\w-]+$/.test(fileId)) {
          files[fileId] = {
            type: 'file',
            id: fileId,
            name: attrs['name'] ?? fileId,
            size: attrs['size'] ?? 0,
          };
        }
      }
      const children = node['content'];
      if (Array.isArray(children)) stack.push(...[...children].reverse());
    }
  } else {
    const html = String(content['html'] ?? '');
    const anchorRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;
    let m: RegExpExecArray | null;
    while ((m = anchorRe.exec(html))) {
      const href = m[1];
      const text = (m[2] ?? '').replace(/<[^>]+>/g, '');
      const match = /^\/api\/v1\/files\/([\w-]+)\/content$/.exec(href);
      if (match) {
        files[match[1]] = { type: 'file', id: match[1], name: text || match[1], size: 0 };
      }
    }
  }
  return Object.values(files);
}

export function getNoteFiles(data: Record<string, any> | null | undefined): Array<Record<string, any>> {
  return normalizePages(data ?? null).pages.flatMap((page) => getContentFiles(page.content));
}

export function sanitizeNoteData(data: Record<string, any> | null | undefined): Record<string, any> | null {
  if (data === null || data === undefined) return null;
  if (typeof data !== 'object' || Array.isArray(data)) return { content: { md: String(data) } };
  const content = data['content'];
  if (!content || typeof content !== 'object' || Array.isArray(content) || !('md' in content)) return data;
  const md = content['md'];
  if (typeof md === 'string' || md === null || md === undefined) return data;
  const mdText =
    md !== null && typeof md === 'object'
      ? '```json\n' + JSON.stringify(md, null, 2) + '\n```'
      : String(md);
  return { ...data, content: { ...content, md: mdText } };
}

export function normalizePages(data: Record<string, any> | null | undefined, noteTitle: string | null = null): Record<string, any> {
  const d: Record<string, any> = data ? structuredClone(data) : {};
  const mainPage = () => ({
    id: 'main',
    title: noteTitle ?? 'Untitled',
    content: d['content'] ?? { json: null, html: '', md: '' },
    versions: d['versions'] ?? [],
    revision: 0,
    generation: 0,
  });
  if (!d['pages'] || !Array.isArray(d['pages']) || !d['pages'].length) {
    d['pages'] = [mainPage()];
  }
  if (!d['pages'].some((p: NotePage) => p.id === 'main')) {
    d['pages'].unshift({ id: 'main', title: noteTitle ?? 'Untitled', content: { json: null, html: '', md: '' }, versions: [], revision: 0, generation: 0 });
  }
  if (noteTitle !== null) {
    for (const page of d['pages']) {
      if (page.id === 'main' && (page.inherit_note_title ?? true)) {
        page.title = noteTitle || 'Untitled';
      }
    }
  }
  d['pages'] = orderPages(d['pages']);
  const legacyFiles = Array.isArray(d['files']) ? d['files'] : [];
  delete d['files'];
  for (const page of d['pages']) {
    if (page.files === undefined) {
      const references = JSON.stringify([page.content ?? null, page.versions ?? null]);
      page.files =
        page.id === 'main'
          ? legacyFiles
          : legacyFiles.filter(
              (file: any) =>
                file &&
                typeof file === 'object' &&
                file.type === 'image' &&
                references.includes(`data://${file.id}`)
            );
    }
    delete page.files;
  }
  d['pages_revision'] ??= 0;
  delete d['versions'];
  const pages: NotePage[] = d['pages'];
  const paths = pagePaths(pages);
  d['content'] =
    pages.length === 1
      ? structuredClone(pages[0].content)
      : {
          json: null,
          md: pages.map((p) => `## ${paths[p.id]}\n\n${p.content?.['md'] ?? ''}`).join('\n\n'),
          html: '',
        };
  d['search_text'] = pages.map((p) => `${paths[p.id]}\n${p.content?.['md'] ?? ''}`).join('\n\n');
  return d;
}

export function getNotePage(data: Record<string, any>, pageId: string | null = null): NotePage {
  const pages = normalizePages(data)['pages'];
  if (pageId === null) {
    if (pages.length !== 1) throw new NotePageConflict('Select a page before editing this note');
    return pages[0];
  }
  const page = pages.find((p) => p.id === pageId);
  if (!page) throw new NotePageConflict('Page no longer exists');
  return page;
}

export function matchingPage(data: Record<string, any> | null | undefined, query = ''): NotePage {
  const pages = normalizePages(data ?? null)['pages'];
  const paths = pagePaths(pages);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  for (const requireAll of [true, false]) {
    for (const page of pages) {
      const text = `${paths[page.id]} ${page.content?.['md'] ?? ''}`.toLowerCase();
      if (terms.length && (requireAll ? terms.every((t) => text.includes(t)) : terms.some((t) => text.includes(t)))) {
        return page;
      }
    }
  }
  return pages[0];
}

export type NotePageOperation = {
  action: 'create' | 'rename' | 'duplicate' | 'reorder' | 'move' | 'delete';
  page_id?: string | null;
  new_id?: string | null;
  parent_id?: string | null;
  before_id?: string | null;
  title?: string | null;
  order?: string[] | null;
  revision: number;
};

export function applyPageOperation(data: Record<string, any>, operation: NotePageOperation): Record<string, any> {
  const d = normalizePages(data);
  const pages: NotePage[] = d['pages'];
  if (operation.action === 'create' || operation.action === 'duplicate') {
    if (!operation.new_id) throw new Error('A new page ID is required');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operation.new_id)) {
      throw new Error('bad UUID'); // uuid.UUID(new_id) equivalent validation error
    }
    if (pages.some((p) => p.id === operation.new_id)) return d;
  }
  if (operation.revision !== d['pages_revision']) {
    throw new NotePageConflict('Pages changed. Refresh and try again');
  }
  if (operation.action === 'create') {
    const title = (operation.title ?? '').trim();
    if (!title) throw new Error('Page title is required');
    pages.push({
      id: operation.new_id as string,
      parent_id: operation.parent_id ?? null,
      title,
      content: { json: null, html: '', md: '' },
      versions: [],
      revision: 0,
      generation: 0,
    });
  } else if (operation.action === 'reorder') {
    const order = operation.order ?? [];
    const ids = new Set(pages.map((p) => p.id));
    if (order.length !== pages.length || new Set(order).size !== order.length || !order.every((id) => ids.has(id))) {
      throw new Error('Order must contain each page exactly once');
    }
    if (order[0] !== 'main') throw new Error('The default page must stay first');
    const lookup = new Map(pages.map((p) => [p.id, p]));
    d['pages'] = order.map((id) => lookup.get(id) as NotePage);
  } else {
    const page = pages.find((p) => p.id === operation.page_id);
    if (!page) throw new NotePageConflict('Page no longer exists');
    if (page.id === 'main' && (operation.action === 'move' || operation.action === 'delete')) {
      throw new Error('The default page cannot be moved or deleted');
    }
    if (operation.action === 'rename') {
      const title = (operation.title ?? '').trim();
      if (!title) throw new Error('Page title is required');
      page.title = title;
      if (page.id === 'main') page.inherit_note_title = false;
    } else if (operation.action === 'move') {
      const parentId = operation.parent_id ?? null;
      if (operation.before_id === 'main') throw new Error('The default page must stay first');
      const branch = subtreeIds(pages, page.id);
      if (parentId && branch.has(parentId)) {
        throw new Error('A page cannot be nested inside itself or its subpages');
      }
      if (parentId !== null && !pages.some((p) => p.id === parentId)) {
        throw new Error('Parent page no longer exists');
      }
      const branchPages = pages.filter((p) => branch.has(p.id));
      const remaining = pages.filter((p) => !branch.has(p.id));
      let position = remaining.length;
      if (operation.before_id !== null && operation.before_id !== undefined) {
        const anchor = remaining.find((p) => p.id === operation.before_id);
        if (!anchor || (anchor.parent_id ?? null) !== parentId) {
          throw new Error('Move target must be a sibling in the destination');
        }
        position = remaining.indexOf(anchor);
      }
      page.parent_id = parentId;
      d['pages'] = [...remaining.slice(0, position), ...branchPages, ...remaining.slice(position)];
    } else if (operation.action === 'delete') {
      if (pages.length === 1) throw new Error('A note must have at least one page');
      for (const child of pages) {
        if ((child.parent_id ?? null) === page.id) child.parent_id = page.parent_id ?? null;
      }
      d['pages'] = pages.filter((p) => p.id !== page.id);
    } else if (operation.action === 'duplicate') {
      const branch = subtreeIds(pages, page.id);
      const branchPages = pages.filter((p) => branch.has(p.id));
      const newRoot = operation.new_id as string;
      const ids: Record<string, string> = {};
      // uuid5(namespace=new_id, name=p.id) — deterministic derivation
      for (const p of branchPages) ids[p.id] = deterministicUuid5(newRoot, p.id);
      ids[page.id] = newRoot;
      if ([...new Set(Object.values(ids))].some((id) => pages.some((p) => p.id === id))) {
        throw new Error('A duplicated page ID already exists');
      }
      const copies: NotePage[] = branchPages.map((p) => ({
        ...structuredClone(p),
        id: ids[p.id],
        parent_id: ids[p.parent_id ?? ''] ?? p.parent_id ?? null,
        versions: [],
        revision: 0,
        generation: 0,
      }));
      copies[0].title = String(page.title).slice(0, 193) + ' (Copy)';
      const position = pages.indexOf(branchPages[branchPages.length - 1]) + 1;
      pages.splice(position, 0, ...copies);
    }
  }
  d['pages_revision'] += 1;
  return normalizePages(d);
}

/** Deterministic UUIDv5-style derivation (namespace + name → uuid). */
function deterministicUuid5(namespace: string, name: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < namespace.length; i++) {
    h1 = Math.imul(h1 ^ namespace.charCodeAt(i), 16777619) >>> 0;
  }
  for (let i = 0; i < name.length; i++) {
    h2 = Math.imul(h2 ^ name.charCodeAt(i), 2166136261) >>> 0;
  }
  const hex = (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 8) +
    h2.toString(16).padStart(8, '0').slice(2, 6) + '-4' + h1.toString(16).padStart(8, '0').slice(1, 4) + '-' +
    ((h1 ^ h2) >>> 0).toString(16).padStart(8, '0').slice(0, 12);
  const raw = hex.replace(/-/g, '').padEnd(32, '0').slice(0, 32);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20, 32)}`;
}

export function updatePageContent(
  data: Record<string, any>,
  pageId: string | null,
  changes: Record<string, any>,
  generation: number | null = null,
  revision: number | null = null
): Record<string, any> {
  const d = normalizePages(data);
  const target = getNotePage(d, pageId);
  const page = d['pages'].find((p) => p.id === target.id) as NotePage;
  if (generation !== null && generation !== (page.generation ?? 0)) {
    throw new NotePageConflict('Page changed; reload before editing');
  }
  if (revision !== null && revision !== (page.revision ?? 0)) {
    throw new NotePageConflict('Page content changed. Read it again before editing');
  }
  if ('content' in changes) {
    const content = changes['content'];
    if (!content || typeof content !== 'object' || Array.isArray(content) ||
        ['md', 'html'].some((k) => k in content && typeof content[k] !== 'string')) {
      throw new Error('Page content must contain text markdown and HTML');
    }
    page.content = { json: null, html: '', md: '', ...structuredClone(content) };
    page.revision = (page.revision ?? 0) + 1;
    if (generation === null) page.generation = (page.generation ?? 0) + 1;
  }
  if ('versions' in changes) {
    page.versions = structuredClone(changes['versions'] ?? []);
  }
  if ('files' in changes) {
    throw new Error('Attach files through page content');
  }
  return normalizePages(d);
}

// ---------------------------------------------------------------------------
// Notes table (models/notes.py)
// ---------------------------------------------------------------------------

export type NoteModel = {
  id: string;
  user_id: string;
  title: string;
  data: Record<string, any> | null;
  meta: Record<string, any> | null;
  is_pinned: boolean;
  access_grants: AccessGrantModel[];
  created_at: number;
  updated_at: number;
};

async function noteRowToModel(row: {
  id: string;
  user_id: string | null;
  title: string | null;
  data: string | null;
  meta: string | null;
  created_at: number | null;
  updated_at: number | null;
}, grants?: AccessGrantModel[]): Promise<NoteModel> {
  const sanitized = sanitizeNoteData(safeParse<Record<string, any> | null>(row.data, null));
  return {
    id: row.id,
    user_id: row.user_id ?? '',
    title: row.title ?? '',
    data: normalizePages(sanitized, row.title ?? ''),
    meta: safeParse<Record<string, any> | null>(row.meta, null),
    is_pinned: false,
    access_grants: grants ?? (await getGrantsByResource('note', row.id)),
    created_at: row.created_at ?? 0,
    updated_at: row.updated_at ?? 0,
  };
}

export async function getNoteById(id: string): Promise<NoteModel | null> {
  const row = await db.note.findFirst({ where: { id } });
  if (!row) return null;
  return noteRowToModel(row);
}

export async function getNotesByUserId(
  userId: string,
  permission: 'read' | 'write' = 'read',
  skip?: number | null,
  limit?: number | null
): Promise<NoteModel[]> {
  const groups = await getUserGroupIds(userId);
  const rows = await db.note.findMany({
    orderBy: { updated_at: 'desc' },
    ...(skip !== null && skip !== undefined ? { skip } : {}),
    ...(limit !== null && limit !== undefined ? { take: limit } : {}),
  });
  const accessible = await getAccessibleResourceIds(userId, 'note', rows.map((r) => r.id), permission, groups);
  const filtered = rows.filter((r) => r.user_id === userId || accessible.has(r.id));
  const grantsMap = await getGrantsByResources('note', filtered.map((r) => r.id));
  const out: NoteModel[] = [];
  for (const row of filtered) out.push(await noteRowToModel(row, grantsMap[row.id] ?? []));
  return out;
}

/** All notes regardless of ownership (admin bypass path). */
export async function getAllNotes(): Promise<NoteModel[]> {
  const rows = await db.note.findMany({ orderBy: { updated_at: 'desc' } });
  const grantsMap = await getGrantsByResources('note', rows.map((r) => r.id));
  const out: NoteModel[] = [];
  for (const row of rows) out.push(await noteRowToModel(row, grantsMap[row.id] ?? []));
  return out;
}

export async function getPinnedNotesByUserId(userId: string, permission: 'read' | 'write' = 'read'): Promise<NoteModel[]> {
  const groups = await getUserGroupIds(userId);
  const pins = await db.pinnedNote.findMany({ where: { user_id: userId }, orderBy: { created_at: 'desc' } });
  const noteIds = pins.map((p) => p.note_id);
  if (!noteIds.length) return [];
  const rows = await db.note.findMany({ where: { id: { in: noteIds } } });
  const accessible = await getAccessibleResourceIds(userId, 'note', rows.map((r) => r.id), permission, groups);
  const filtered = rows.filter((r) => r.user_id === userId || accessible.has(r.id));
  const grantsMap = await getGrantsByResources('note', filtered.map((r) => r.id));
  const order = new Map(pins.map((p) => [p.note_id, p.created_at]));
  filtered.sort((a, b) => (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0));
  const out: NoteModel[] = [];
  for (const row of filtered) out.push(await noteRowToModel(row, grantsMap[row.id] ?? []));
  return out;
}

export async function getPinnedNoteIds(userId: string): Promise<string[]> {
  const pins = await db.pinnedNote.findMany({ where: { user_id: userId }, select: { note_id: true } });
  return pins.map((p) => p.note_id);
}

export async function insertNewNote(
  userId: string,
  form: {
    title: string;
    data?: Record<string, any> | null;
    meta?: Record<string, any> | null;
    access_grants?: any[] | null;
  }
): Promise<NoteModel | null> {
  const now = nowNs();
  const id = uuid();
  const sanitized = sanitizeNoteData(form.data ?? null) ?? {};
  if (sanitized && typeof sanitized === 'object' && 'pages' in sanitized) {
    throw new HttpError(400, 'Create pages using page operations');
  }
  const data = normalizePages(sanitized, form.title);
  await db.note.create({
    data: {
      id,
      user_id: userId,
      title: form.title,
      data: JSON.stringify(data),
      meta: JSON.stringify(form.meta ?? {}),
      created_at: now,
      updated_at: now,
    },
  });
  await setAccessGrants('note', id, form.access_grants ?? null);
  return await getNoteById(id);
}

export async function updateNoteById(
  id: string,
  form: {
    title?: string | null;
    data?: Record<string, any> | null;
    meta?: Record<string, any> | null;
    page_id?: string | null;
    page_revision?: number | null;
    page_generation?: number | null;
    page_operation?: NotePageOperation | null;
  }
): Promise<NoteModel | null> {
  const incoming = form.data ?? {};
  if ('pages' in incoming || 'pages_revision' in incoming) {
    throw new Error('Use page operations instead of replacing all pages');
  }
  const existing = await db.note.findFirst({ where: { id } });
  if (!existing) return null;
  const previousUpdatedAt = existing.updated_at ?? 0;
  let data = normalizePages(sanitizeNoteData(safeParse<Record<string, any> | null>(existing.data, null)), existing.title ?? '');
  if (form.page_operation) {
    data = applyPageOperation(data, form.page_operation);
  }
  const incomingKeys = Object.keys(incoming);
  if (incomingKeys.some((k) => ['content', 'versions', 'files'].includes(k))) {
    const hasContentOrVersions = incomingKeys.some((k) => ['content', 'versions'].includes(k));
    data = updatePageContent(
      data,
      form.page_id ?? (hasContentOrVersions ? null : 'main'),
      incoming,
      form.page_generation ?? null,
      form.page_revision ?? null
    );
  }
  data = normalizePages(
    {
      ...data,
      ...Object.fromEntries(Object.entries(incoming).filter(([k]) => !['content', 'versions', 'files'].includes(k))),
    },
    form.title ?? existing.title ?? ''
  );
  const values: Record<string, any> = {
    data: JSON.stringify(data),
    updated_at: Math.max(nowNs(), previousUpdatedAt + 1),
  };
  if (form.title !== undefined && form.title !== null) values.title = form.title;
  if (form.meta !== undefined && form.meta !== null) {
    const currentMeta = safeParse<Record<string, any> | null>(existing.meta, null) ?? {};
    values.meta = JSON.stringify({ ...currentMeta, ...(form.meta ?? {}) });
  }
  const updated = await db.note.updateMany({ where: { id, updated_at: previousUpdatedAt }, data: values });
  if (!updated.count) {
    throw new NotePageConflict('Note changed while saving. Please try again');
  }
  return await getNoteById(id);
}

export async function toggleNotePinnedById(id: string, userId: string): Promise<NoteModel | null> {
  const note = await db.note.findFirst({ where: { id } });
  if (!note) return null;
  const pin = await db.pinnedNote.findFirst({ where: { user_id: userId, note_id: id } });
  if (pin) {
    await db.pinnedNote.deleteMany({ where: { user_id: userId, note_id: id } });
  } else {
    await db.pinnedNote.create({
      data: { id: uuid(), user_id: userId, note_id: id, created_at: nowNs() },
    });
  }
  return await getNoteById(id);
}

export async function deleteNoteById(id: string): Promise<boolean> {
  await revokeAllAccess('note', id);
  await db.pinnedNote.deleteMany({ where: { note_id: id } });
  await db.note.delete({ where: { id } });
  return true;
}

// ---------------------------------------------------------------------------
// Skills table (light helpers — shared with the skills router)
// ---------------------------------------------------------------------------

export type SkillModel = {
  id: string;
  user_id: string | null;
  name: string | null;
  description: string | null;
  content: string | null;
  data: Record<string, any> | null;
  version_id: string | null;
  meta: Record<string, any> | null;
  is_active: boolean;
  updated_at: number | null;
  created_at: number | null;
};

export async function getSkills(): Promise<SkillModel[]> {
  const rows = await db.skill.findMany();
  return rows.map((row) => ({
    id: row.id,
    user_id: row.user_id ?? null,
    name: row.name ?? null,
    description: row.description ?? null,
    content: row.content ?? null,
    data: safeParse<Record<string, any> | null>(row.data, null),
    version_id: row.version_id ?? null,
    meta: safeParse<Record<string, any> | null>(row.meta, null),
    is_active: row.is_active ?? true,
    updated_at: row.updated_at ?? null,
    created_at: row.created_at ?? null,
  }));
}

export async function getSkillById(id: string): Promise<SkillModel | null> {
  const row = await db.skill.findUnique({ where: { id } });
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id ?? null,
    name: row.name ?? null,
    description: row.description ?? null,
    content: row.content ?? null,
    data: safeParse<Record<string, any> | null>(row.data, null),
    version_id: row.version_id ?? null,
    meta: safeParse<Record<string, any> | null>(row.meta, null),
    is_active: row.is_active ?? true,
    updated_at: row.updated_at ?? null,
    created_at: row.created_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Config namespace helpers (models/config.py get_all / get_namespace / upsert)
// ---------------------------------------------------------------------------

export async function configGetAll(): Promise<Record<string, any>> {
  const rows = await db.config.findMany();
  const out: Record<string, any> = {};
  for (const row of rows) out[row.key] = safeParse<any>(row.value, row.value);
  return out;
}

export async function configGetNamespace(namespace: string): Promise<Record<string, any>> {
  const rows = await db.config.findMany({ where: { key: { startsWith: `${namespace}.` } } });
  const out: Record<string, any> = {};
  for (const row of rows) out[row.key] = safeParse<any>(row.value, row.value);
  return out;
}
