import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import zlib from 'zlib';
import { configGet } from '@/lib/config';
import { ERROR_MESSAGES } from '@/lib/constants';
import { getUserGroupIds, hasPermission, hasAccessGrant } from '@/lib/access-control';
import { db } from '@/lib/db';
import {
  setAccessGrants,
  validateAccessGrants,
  filterAllowedAccessGrants,
  getAccessibleResourceIds,
  toUserResponse,
  getUsersByIds,
  safeParse,
  nowSec,
  uuid,
  unifiedDiff,
  EM,
} from '@/lib/models/workspace';

/**
 * Port of open_webui/routers/skills.py (/api/v1/skills).
 *
 * Deviations (documented):
 *  - Skill files are virtual (path/content pairs in `skill.data` JSON) exactly
 *    as upstream; ZIP import/export is implemented with node:zlib (stored +
 *    deflate entries) instead of Python's zipfile.
 *  - YAML frontmatter parsing is a minimal `key: value` subset of
 *    yaml.safe_load (names/descriptions are plain scalars in practice).
 *  - load_skill_from_url performs scheme/credential checks and redirect
 *    following, but not the full SSRF validation pipeline.
 *  - Events (publish_event) are no-ops — no socket runtime.
 */

const BYPASS_ADMIN_ACCESS_CONTROL = (process.env.BYPASS_ADMIN_ACCESS_CONTROL ??
  process.env.ENABLE_ADMIN_WORKSPACE_CONTENT_ACCESS ??
  'True').toLowerCase() === 'true';

const PAGE_ITEM_COUNT = 30;

// ---------------------------------------------------------------------------
// utils/skill_files.py port
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 1000;

type SkillFile = { path: string; content: string; encoding?: 'base64' };

type SkillFileOperation = {
  op: 'put' | 'move' | 'delete';
  path: string;
  content?: string | null;
  encoding?: 'base64' | null;
  destination?: string | null;
};

function validatePath(path: string): string {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\x00') || path.includes(':')) {
    throw new Error('File paths must be relative POSIX paths');
  }
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Invalid file path');
  }
  return path;
}

function fileBytes(file: SkillFile): Buffer {
  if (file.encoding === 'base64') {
    return Buffer.from(file.content, 'base64');
  }
  return Buffer.from(file.content, 'utf-8');
}

function encodeFile(path: string, data: Buffer): SkillFile {
  const text = data.toString('utf-8');
  if (!text.includes('\x00') && Buffer.compare(Buffer.from(text, 'utf-8'), data) === 0) {
    return { path, content: text };
  }
  return { path, content: data.toString('base64'), encoding: 'base64' };
}

function validateFiles(files: SkillFile[], previous?: SkillFile[] | null): SkillFile[] {
  const result: SkillFile[] = [];
  const paths = new Set<string>();
  let total = 0;
  const prev = new Map<string, SkillFile>((previous ?? []).map((f) => [f.path, f]));
  if (files.length > Math.max(MAX_FILES, prev.size)) {
    throw new Error(`A skill may contain at most ${MAX_FILES} files`);
  }
  for (const item of files) {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string' || typeof item.content !== 'string') {
      throw new Error('Invalid file entry');
    }
    if (item.encoding !== undefined && item.encoding !== null && item.encoding !== 'base64') {
      throw new Error('Invalid file encoding');
    }
    const file: SkillFile = item.encoding ? { path: item.path, content: item.content, encoding: 'base64' } : { path: item.path, content: item.content };
    const path = validatePath(file.path);
    if (paths.has(path)) throw new Error(`Duplicate file: ${path}`);
    paths.add(path);
    const size = fileBytes(file).length;
    const oldSize = prev.has(path) ? fileBytes(prev.get(path)!).length : 0;
    if (size > Math.max(MAX_FILE_BYTES, oldSize)) throw new Error(`File exceeds 10 MiB: ${path}`);
    total += size;
    result.push(file);
  }
  const prevTotal = [...prev.values()].reduce((acc, f) => acc + fileBytes(f).length, 0);
  if (total > Math.max(MAX_SKILL_BYTES, prevTotal)) throw new Error('Skill exceeds 50 MiB');
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (paths.has(parent)) throw new Error(`A file is also used as a directory: ${path}`);
    }
  }
  const root = result.find((f) => f.path === 'SKILL.md');
  if (!root || root.encoding) throw new Error('A skill requires a UTF-8 SKILL.md at its root');
  return [...result].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function applyOperations(files: SkillFile[], operations: SkillFileOperation[]): SkillFile[] {
  const result = new Map<string, SkillFile>(files.map((f) => [f.path, { ...f }]));
  for (const raw of operations) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid file operation');
    const op = raw.op;
    if (op !== 'put' && op !== 'move' && op !== 'delete') throw new Error('Invalid file operation');
    const path = validatePath(String(raw.path ?? ''));
    if (op === 'put') {
      if (raw.content === null || raw.content === undefined) throw new Error('put requires content');
      const entry: SkillFile = { path, content: String(raw.content) };
      if (raw.encoding) entry.encoding = 'base64';
      result.set(path, entry);
    } else {
      if (path === 'SKILL.md') throw new Error('SKILL.md cannot be moved or deleted');
      const matched = [...result.keys()].filter((p) => p === path || p.startsWith(`${path}/`));
      if (!matched.length) throw new Error(`File or directory not found: ${path}`);
      if (op === 'move') {
        const destination = validatePath(String(raw.destination ?? ''));
        if (destination.startsWith(`${path}/`)) throw new Error('Cannot move a directory into itself');
        const moved = new Map<string, SkillFile>();
        for (const p of matched) {
          moved.set(destination + p.slice(path.length), { ...result.get(p)! });
        }
        for (const p of moved.keys()) {
          if (result.has(p) && !matched.includes(p)) throw new Error('Move would overwrite an existing file');
        }
        for (const p of matched) result.delete(p);
        for (const [p, f] of moved.entries()) result.set(p, { ...f, path: p });
      } else {
        for (const p of matched) result.delete(p);
      }
    }
  }
  return validateFiles([...result.values()], files);
}

/** Minimal YAML frontmatter subset (yaml.safe_load for flat scalars). */
function frontmatter(content: string): Record<string, any> {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return {};
  const out: Record<string, any> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+):\s*(.*)\s*$/);
    if (!m) continue;
    let value: any = m[2];
    if (value === 'null' || value === '~' || value === '') value = null;
    else if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (/^-?\d+$/.test(value)) value = Number(value);
    else if (/^-?\d+\.\d+$/.test(value)) value = Number(value);
    else if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    else if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    }
    out[m[1]] = value;
  }
  return out;
}

function fileSummaries(files: SkillFile[]): Array<{ path: string; size: number; encoding: string | null }> {
  return files.map((f) => ({ path: f.path, size: fileBytes(f).length, encoding: f.encoding ?? null }));
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader/writer (zipfile.py parity for import/export)
// ---------------------------------------------------------------------------

type ZipEntry = { path: string; data: Buffer };

function zipRead(buffer: Buffer): ZipEntry[] {
  // locate End Of Central Directory
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 22 - 65536; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Invalid ZIP archive');
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP archive');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLen).toString('utf-8');
    if (flags & 0x1) throw new Error('Encrypted skill archives are not supported');

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Invalid ZIP archive');
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.slice(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) data = raw;
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw);
      } catch {
        throw new Error('Skill archive uses an unsupported compression method');
      }
    } else {
      throw new Error('Skill archive uses an unsupported compression method');
    }
    if (name.endsWith('/')) {
      // directory entry
    } else {
      entries.push({ path: name, data });
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipWrite(entries: Array<{ path: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const encoder = new TextEncoder();
  for (const entry of entries) {
    const nameBuf = Buffer.from(encoder.encode(entry.path));
    const crc = crc32(entry.data);
    const compressed = zlib.deflateRawSync(entry.data, { level: 6 });
    const useDeflate = compressed.length < entry.data.length;
    const payload = useDeflate ? compressed : entry.data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, payload);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += 30 + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ---------------------------------------------------------------------------
// parse_import / zip_export / load_skill_from_url (utils/skill_files.py)
// ---------------------------------------------------------------------------

function parseImport(
  data: Buffer,
  filename: string,
  opts: { discoverSkills?: boolean; directory?: string | null } = {}
): Array<Record<string, any>> {
  if (data.length > MAX_IMPORT_BYTES) throw new Error('Import exceeds 200 MiB');
  const lower = filename.toLowerCase();
  let packages: Array<Record<string, any>>;
  if (lower.endsWith('.json')) {
    const value = safeParse<any>(data.toString('utf-8'), null);
    if (value === null) throw new Error('Invalid JSON');
    packages = Array.isArray(value) ? value : [value];
  } else if (lower.endsWith('.zip') || lower.endsWith('.skill')) {
    const entries = zipRead(data);
    const entryMap = new Map<string, Buffer>();
    for (const entry of entries) {
      const path = entry.path.replace(/\/+$/, '');
      if (opts.directory !== null && opts.directory !== undefined) {
        const stripped = path.split('/').slice(1).join('/');
        if (!stripped.startsWith(opts.directory)) continue;
        if (stripped) entryMap.set(stripped, entry.data);
      } else {
        if (entryMap.has(path)) throw new Error(`Duplicate archive path: ${path}`);
        entryMap.set(path, entry.data);
      }
    }
    const paths = [...entryMap.keys()];
    let roots: string[];
    if (entryMap.has('SKILL.md')) {
      roots = [''];
    } else {
      roots = paths.filter((p) => p.endsWith('/SKILL.md')).map((p) => p.slice(0, -'SKILL.md'.length)).sort();
    }
    if (!roots.length) throw new Error('Archive contains no SKILL.md');
    roots = roots.filter((root) => !roots.some((parent) => parent !== root && root.startsWith(parent)));
    if (!opts.discoverSkills && paths.some((p) => !roots.some((root) => p.startsWith(root)))) {
      throw new Error('Archive contains files outside skill directories');
    }
    packages = roots.map((root) => ({
      files: paths
        .filter((p) => p.startsWith(root))
        .map((p) => {
          const file = encodeFile(p.slice(root.length), entryMap.get(p)!);
          return { path: file.path, content: file.content, ...(file.encoding ? { encoding: file.encoding } : {}) };
        }),
    }));
  } else if (lower.endsWith('.md')) {
    packages = [{ files: [encodeFile('SKILL.md', data)] }];
  } else {
    throw new Error('Use JSON, ZIP, .skill, or Markdown');
  }

  let total = 0;
  const result: Array<Record<string, any>> = [];
  for (const pkg of packages) {
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('Each imported skill must be an object');
    const files = validateFiles(
      'files' in pkg ? pkg['files'] : [{ path: 'SKILL.md', content: String(pkg['content'] ?? '') }]
    );
    total += files.reduce((acc, f) => acc + fileBytes(f).length, 0);
    if (total > MAX_IMPORT_BYTES) throw new Error('Import exceeds 200 MiB decoded');
    const rootFile = files.find((f) => f.path === 'SKILL.md')!;
    const fm = frontmatter(rootFile.content);
    const name = pkg['name'] ?? fm['name'] ?? 'Imported skill';
    result.push({
      id: pkg['id'] ?? String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') ?? 'imported-skill',
      name: String(name),
      description: pkg['description'] ?? fm['description'] ?? '',
      meta: pkg['meta'] ?? {},
      ...(pkg['is_active'] !== undefined ? { is_active: pkg['is_active'] } : {}),
      files,
    });
  }
  for (const pkg of result) {
    if (!pkg['id']) pkg['id'] = 'imported-skill';
  }
  return result;
}

function zipExport(packages: Array<Record<string, any>>): Buffer {
  const entries: Array<{ path: string; data: Buffer }> = [];
  const roots = new Set<string>();
  for (const pkg of packages) {
    const files = (pkg['files'] ?? []) as SkillFile[];
    const rootFile = files.find((f) => f.path === 'SKILL.md');
    if (!rootFile) throw new Error('A skill requires a UTF-8 SKILL.md at its root');
    const fmName = frontmatter(rootFile.content)['name'];
    const root =
      typeof fmName === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fmName) ? fmName : String(pkg['id']);
    validatePath(root);
    if (roots.has(root)) throw new Error('Selected skills have duplicate export directory names');
    roots.add(root);
    for (const file of files) {
      entries.push({ path: `${root}/${validatePath(file.path)}`, data: fileBytes(file) });
    }
  }
  return zipWrite(entries);
}

/** Python: skill_import_source — GitHub URLs → codeload archive URLs. */
function skillImportSource(url: string): [string, string | null] {
  const parsed = new URL(url.trim());
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error('Use an HTTP(S) URL without embedded credentials');
  }
  if (parsed.hostname.toLowerCase() !== 'github.com') return [url.trim(), null];
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < 2 || parts.slice(0, 2).some((part) => !/^[\w.-]+$/.test(part) || part === '.' || part === '..')) {
    throw new Error('Invalid GitHub repository URL');
  }
  const [owner, repoRaw] = parts;
  const repo = repoRaw.replace(/\.git$/, '');
  if (!repo) throw new Error('Invalid GitHub repository URL');
  let ref = 'HEAD';
  let directory = '';
  if (parts.length > 2) {
    if (['archive', 'releases', 'raw'].includes(parts[2])) return [url.trim(), null];
    if (parts.length < 4 || !['tree', 'blob'].includes(parts[2])) {
      throw new Error('Use a GitHub repository, folder, or SKILL.md URL');
    }
    ref = validatePath(decodeURIComponent(parts[3]));
    const path = parts.slice(4).map((p) => decodeURIComponent(p)).join('/');
    if (parts[2] === 'blob') {
      if (!path || path.split('/').pop() !== 'SKILL.md') {
        throw new Error('Select a SKILL.md file or a skill folder');
      }
    }
    const trimmed = parts[2] === 'blob' ? path.replace(/SKILL\.md$/, '').replace(/\/+$/, '') : path;
    directory = trimmed ? `${validatePath(trimmed)}/` : '';
  }
  return [`https://codeload.github.com/${owner}/${repo}/zip/${encodeURIComponent(ref)}`, directory];
}

async function loadSkillFromUrl(url: string): Promise<Array<Record<string, any>>> {
  const [target, directory] = skillImportSource(url);
  let current = target;
  for (let redirect = 0; redirect < 6; redirect++) {
    const parsed = new URL(current);
    if (parsed.username || parsed.password) throw new Error('Use a URL without embedded credentials');
    const response = await fetch(current, {
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location') ?? '';
      current = new URL(location, current).toString();
      continue;
    }
    if (response.status !== 200) throw new Error('Could not download the skill. Check that the URL is accessible.');
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (contentType === 'text/html') {
      throw new Error('The URL returned a web page. Use a raw skill file or a ZIP/.skill download link.');
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_IMPORT_BYTES) throw new Error('Import exceeds 200 MiB');
    let filename: string;
    if (contentType === 'application/json') filename = 'skills.json';
    else if (contentType === 'text/markdown') filename = 'SKILL.md';
    else filename = decodeURIComponent(new URL(current).pathname.split('/').pop() ?? '');
    if (data.subarray(0, 2).toString('latin1') === 'PK') filename = 'skills.zip';
    return parseImport(data, filename, { discoverSkills: true, directory });
  }
  throw new Error('Too many redirects while downloading the skill');
}

// ---------------------------------------------------------------------------
// Skills data layer (models/skills.py port — lives here because the shared
// workspace module only exposes light helpers)
// ---------------------------------------------------------------------------

type SkillRow = {
  id: string;
  user_id: string | null;
  name: string | null;
  description: string | null;
  content: string | null;
  data: string | null;
  version_id: string | null;
  meta: string | null;
  is_active: boolean | null;
  updated_at: number | null;
  created_at: number | null;
};

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
  access_grants: any[];
};

function rowToSkill(row: SkillRow, grants: any[] = []): SkillModel {
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
    access_grants: grants,
  };
}

function normalizeSkillMeta(meta: any): { i18n: Record<string, Record<string, string>> | null; tags: string[] } {
  if (!meta || typeof meta !== 'object') return { i18n: null, tags: [] };
  return {
    i18n: meta.i18n && typeof meta.i18n === 'object' ? meta.i18n : null,
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
  };
}

function skillSnapshot(skill: {
  name: string | null;
  description: string | null;
  content: string | null;
  data: Record<string, any> | null;
  meta: Record<string, any> | null;
}): Record<string, any> {
  return {
    name: skill.name,
    description: skill.description,
    content: skill.content,
    data: skill.data ?? { files: [] },
    meta: normalizeSkillMeta(skill.meta),
  };
}

async function getSkillGrants(skillId: string): Promise<any[]> {
  const rows = await db.accessGrant.findMany({
    where: { resource_type: 'skill', resource_id: skillId },
    orderBy: { created_at: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    resource_type: r.resource_type,
    resource_id: r.resource_id,
    principal_type: r.principal_type,
    principal_id: r.principal_id,
    permission: r.permission,
    created_at: r.created_at,
  }));
}

async function getSkillById(id: string): Promise<SkillModel | null> {
  const row = (await db.skill.findUnique({ where: { id } })) as SkillRow | null;
  if (!row) return null;
  return rowToSkill(row, await getSkillGrants(id));
}

async function getSkillByName(name: string): Promise<SkillModel | null> {
  const row = (await db.skill.findFirst({ where: { name } })) as SkillRow | null;
  if (!row) return null;
  return rowToSkill(row, await getSkillGrants(row.id));
}

async function getSkillsByAccess(userId: string | null): Promise<SkillModel[]> {
  const rows = (await db.skill.findMany({ orderBy: { updated_at: 'desc' } })) as SkillRow[];
  const userGroupIds = userId ? await getUserGroupIds(userId) : [];
  const grantsMap = userId
    ? await (await import('@/lib/models/workspace')).getGrantsByResources('skill', rows.map((r) => r.id))
    : {};
  const out: SkillModel[] = [];
  for (const row of rows) {
    if (userId === null) {
      out.push(rowToSkill(row, grantsMap[row.id] ?? []));
      continue;
    }
    const grants = grantsMap[row.id] ?? [];
    // PUBLIC-APP MODE: a skill without any access grant is part of the shared
    // catalog — every member can read it (write stays owner/grant-gated).
    const readable =
      row.user_id === userId ||
      grants.length === 0 ||
      grants.some(
        (g) =>
          g.permission === 'read' &&
          ((g.principal_type === 'user' && (g.principal_id === '*' || g.principal_id === userId)) ||
            (g.principal_type === 'group' && userGroupIds.includes(g.principal_id)))
      );
    if (readable) out.push(rowToSkill(row, grants));
  }
  return out;
}

type SkillHistoryEntry = {
  id: string;
  skill_id: string;
  parent_id: string | null;
  snapshot: Record<string, any>;
  user_id: string;
  commit_message: string | null;
  created_at: number;
};

async function newSkillHistoryEntry(
  skillId: string,
  snapshot: Record<string, any>,
  userId: string,
  parentId: string | null,
  commitMessage: string | null
): Promise<SkillHistoryEntry> {
  const entry = {
    id: uuid(),
    skill_id: skillId,
    parent_id: parentId,
    snapshot,
    user_id: userId,
    commit_message: commitMessage,
    created_at: nowSec(),
  };
  await db.skillHistory.create({ data: { ...entry, snapshot: JSON.stringify(snapshot) } });
  return entry;
}

async function getSkillHistoryById(skillId: string, historyId: string): Promise<(SkillHistoryEntry & { user: { name: string } | null }) | null> {
  const row = await db.skillHistory.findFirst({ where: { skill_id: skillId, id: historyId } });
  if (!row) return null;
  const author = await db.user.findUnique({ where: { id: row.user_id }, select: { name: true } });
  return {
    id: row.id,
    skill_id: row.skill_id,
    parent_id: row.parent_id ?? null,
    snapshot: safeParse<Record<string, any>>(row.snapshot, {}),
    user_id: row.user_id,
    commit_message: row.commit_message ?? null,
    created_at: row.created_at,
    user: author ? { name: author.name } : null,
  };
}

async function getSkillHistoryBySkillId(skillId: string, page = 1): Promise<Array<Record<string, any>>> {
  const limit = 20;
  const rows = await db.skillHistory.findMany({
    where: { skill_id: skillId },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    skip: (Math.max(1, page) - 1) * limit,
    take: limit,
  });
  const authors = await getUsersByIds([...new Set(rows.map((r) => r.user_id))]);
  const authorMap = new Map(authors.map((u) => [u.id, u.name]));
  return rows.map((row) => ({
    id: row.id,
    skill_id: row.skill_id,
    parent_id: row.parent_id ?? null,
    user_id: row.user_id,
    commit_message: row.commit_message ?? null,
    created_at: row.created_at,
    user: authorMap.has(row.user_id) ? { name: authorMap.get(row.user_id)! } : null,
  }));
}

async function deleteSkillHistoryEntry(skillId: string, historyId: string): Promise<boolean> {
  const skill = (await db.skill.findUnique({ where: { id: skillId } })) as SkillRow | null;
  if (!skill) return false;
  if (skill.version_id === historyId) {
    throw new HttpError(400, 'Cannot delete the current version');
  }
  const entry = await db.skillHistory.findFirst({ where: { id: historyId, skill_id: skillId } });
  if (!entry) return false;
  await db.skillHistory.updateMany({
    where: { skill_id: skillId, parent_id: historyId },
    data: { parent_id: entry.parent_id ?? null },
  });
  await db.skillHistory.delete({ where: { id: historyId } });
  return true;
}

async function getSkillSnapshot(skill: SkillModel, versionId: string | null): Promise<Record<string, any>> {
  if (!versionId || versionId === skill.version_id) return skillSnapshot(skill);
  const entry = await getSkillHistoryById(skill.id, versionId);
  if (!entry) throw new HttpError(404, 'Skill version not found');
  return entry.snapshot;
}

async function insertNewSkill(userId: string, form: Record<string, any>): Promise<SkillModel> {
  if (form['data'] !== null && form['data'] !== undefined && form['files'] !== null && form['files'] !== undefined) {
    throw new Error('Provide data or files, not both');
  }
  let files: SkillFile[];
  if (form['data'] !== null && form['data'] !== undefined) {
    files = form['data']['files'];
  } else if (form['files'] !== null && form['files'] !== undefined) {
    files = form['files'];
  } else {
    files = [{ path: 'SKILL.md', content: String(form['content'] ?? '') }];
  }
  files = validateFiles(files);
  const meta = normalizeSkillMeta(form['meta']);
  const rootFile = files.find((f) => f.path === 'SKILL.md')!;
  const snapshot = {
    name: form['name'],
    description: form['description'] ?? null,
    meta,
    content: rootFile.content,
    data: { files },
  };
  const entry = await newSkillHistoryEntry(form['id'], snapshot, userId, null, form['commit_message'] ?? null);
  const now = nowSec();
  await db.skill.create({
    data: {
      id: form['id'],
      user_id: userId,
      name: form['name'],
      description: form['description'] ?? null,
      meta: JSON.stringify(meta),
      content: snapshot['content'],
      data: JSON.stringify(snapshot['data']),
      is_active: form['is_active'] ?? true,
      version_id: entry.id,
      created_at: now,
      updated_at: now,
    },
  });
  const grants = await setAccessGrants('skill', form['id'], form['access_grants'] ?? null);
  const row = (await db.skill.findUnique({ where: { id: form['id'] } })) as SkillRow;
  return rowToSkill(row, grants);
}

async function updateSkillById(
  id: string,
  updated: Record<string, any>,
  userId: string | null
): Promise<SkillModel | null> {
  const row = (await db.skill.findUnique({ where: { id } })) as SkillRow | null;
  if (!row) return null;
  const expected = updated['expected_version_id'];
  const hasFiles = updated['files'] !== null && updated['files'] !== undefined;
  const hasData = updated['data'] !== null && updated['data'] !== undefined;
  const hasOperations = updated['operations'] !== null && updated['operations'] !== undefined;
  if (expected !== null && expected !== undefined && expected !== row.version_id) {
    throw new HttpError(409, { code: 'version_conflict', current_version_id: row.version_id } as unknown as string);
  }
  if ((hasFiles || hasData || hasOperations) && (expected === null || expected === undefined)) {
    throw new HttpError(400, 'expected_version_id is required for file updates');
  }
  const current = rowToSkill(row);
  const old = skillSnapshot(current);
  if ([hasFiles, hasData, hasOperations].filter(Boolean).length > 1) {
    throw new HttpError(400, 'Provide data, files, or operations, not more than one');
  }
  let files: SkillFile[] | null = null;
  if (hasData) files = updated['data']['files'];
  else if (hasFiles) files = updated['files'];
  if (files === null) files = (current.data?.['files'] ?? []) as SkillFile[];
  if (hasOperations) files = applyOperations(files, updated['operations']);
  if (updated['content'] !== null && updated['content'] !== undefined) {
    files = [
      ...files.filter((f) => f.path !== 'SKILL.md'),
      { path: 'SKILL.md', content: String(updated['content']) },
    ];
  }
  files = validateFiles(files, (current.data?.['files'] ?? []) as SkillFile[]);

  const snapshot: Record<string, any> = {
    name: updated['name'] !== undefined ? updated['name'] : old['name'],
    description: updated['description'] !== undefined ? updated['description'] : old['description'],
    meta: normalizeSkillMeta(updated['meta'] !== undefined ? updated['meta'] : old['meta']),
  };
  snapshot['data'] = { files };
  const rootFile = files.find((f) => f.path === 'SKILL.md')!;
  snapshot['content'] = rootFile.content;

  const values: Record<string, any> = {
    is_active: updated['is_active'] !== undefined ? updated['is_active'] : current.is_active,
  };
  if (JSON.stringify(snapshot) !== JSON.stringify(old)) {
    // History is listed by whole-second save time, so keep same-second saves in order.
    const latest = await db.skillHistory.aggregate({
      where: { skill_id: id },
      _max: { created_at: true },
    });
    const parentId = row.version_id ?? null;
    const entryBase = {
      id: uuid(),
      skill_id: id,
      parent_id: parentId,
      snapshot: JSON.stringify(snapshot),
      user_id: userId ?? row.user_id ?? '',
      commit_message: updated['commit_message'] ?? null,
      created_at: Math.max(nowSec(), (latest._max.created_at ?? 0) + 1),
    };
    await db.skillHistory.create({ data: entryBase });
    values['name'] = snapshot['name'];
    values['description'] = snapshot['description'];
    values['meta'] = JSON.stringify(snapshot['meta']);
    values['content'] = snapshot['content'];
    values['data'] = JSON.stringify(snapshot['data']);
    values['version_id'] = entryBase.id;
  }
  values['updated_at'] = nowSec();
  const result = await db.skill.updateMany({ where: { id, version_id: row.version_id }, data: values });
  if (result.count !== 1) {
    throw new HttpError(409, { code: 'version_conflict' } as unknown as string);
  }
  return getSkillById(id);
}

async function updateSkillVersion(
  id: string,
  versionId: string,
  expectedVersionId: string
): Promise<SkillModel | null> {
  const row = (await db.skill.findUnique({ where: { id } })) as SkillRow | null;
  if (!row) return null;
  if (expectedVersionId !== row.version_id) {
    throw new HttpError(409, { code: 'version_conflict', current_version_id: row.version_id } as unknown as string);
  }
  const entry = await getSkillHistoryById(id, versionId);
  if (!entry) throw new HttpError(404, 'Skill version not found');
  const snapshot = entry.snapshot;
  const result = await db.skill.updateMany({
    where: { id, version_id: expectedVersionId },
    data: {
      name: snapshot['name'] ?? null,
      description: snapshot['description'] ?? null,
      content: snapshot['content'] ?? null,
      data: JSON.stringify(snapshot['data'] ?? { files: [] }),
      meta: JSON.stringify(normalizeSkillMeta(snapshot['meta'])),
      version_id: versionId,
      updated_at: nowSec(),
    },
  });
  if (result.count !== 1) {
    throw new HttpError(409, { code: 'version_conflict' } as unknown as string);
  }
  return getSkillById(id);
}

async function toggleSkillById(id: string): Promise<SkillModel | null> {
  const row = (await db.skill.findUnique({ where: { id } })) as SkillRow | null;
  if (!row) return null;
  await db.skill.update({
    where: { id },
    data: { is_active: !(row.is_active ?? true), updated_at: nowSec() },
  });
  return getSkillById(id);
}

async function deleteSkillById(id: string): Promise<boolean> {
  try {
    await db.accessGrant.deleteMany({ where: { resource_type: 'skill', resource_id: id } });
    await db.skillHistory.deleteMany({ where: { skill_id: id } });
    await db.skill.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Response shapers (response_model parity)
// ---------------------------------------------------------------------------

function skillUserResponse(skill: SkillModel, user: Record<string, any> | null): Record<string, any> {
  return {
    version_id: skill.version_id,
    id: skill.id,
    user_id: skill.user_id,
    name: skill.name,
    description: skill.description,
    meta: skill.meta,
    is_active: skill.is_active,
    access_grants: skill.access_grants,
    updated_at: skill.updated_at,
    created_at: skill.created_at,
    user,
  };
}

function skillFullResponse(skill: SkillModel): Record<string, any> {
  return {
    id: skill.id,
    user_id: skill.user_id,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    data: skill.data,
    version_id: skill.version_id,
    meta: skill.meta,
    is_active: skill.is_active,
    access_grants: skill.access_grants,
    updated_at: skill.updated_at,
    created_at: skill.created_at,
  };
}

// ---------------------------------------------------------------------------
// Router helpers
// ---------------------------------------------------------------------------

function err(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

function requireUser(ctx: Ctx) {
  const user = ctx.user;
  if (!user) err(401, ERROR_MESSAGES.NOT_AUTHENTICATED);
  return user;
}

async function canEditSkills(user: { id: string; role: string }): Promise<boolean> {
  if (user.role === 'admin') return true;
  const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
  return (
    (await hasPermission(user.id, 'workspace.skills', defaults)) ||
    (await hasPermission(user.id, 'workspace.skills_import', defaults))
  );
}

async function authorizedSkill(
  id: string,
  user: { id: string; role: string },
  permission: 'read' | 'write' = 'read'
): Promise<SkillModel> {
  const skill = await getSkillById(id);
  if (!skill) err(404, 'Skill not found');
  if (
    !(
      (user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL) ||
      skill.user_id === user.id ||
      (await hasAccessGrant(user.id, 'skill', skill.id, permission))
    )
  ) {
    err(403, 'Access denied');
  }
  return skill;
}

async function selectedHistory(
  skill: SkillModel,
  versionId: string | null
): Promise<SkillHistoryEntry & { user: { name: string } | null }> {
  const entry = await getSkillHistoryById(skill.id, versionId ?? skill.version_id ?? '');
  if (!entry) err(404, 'Skill version not found');
  return entry;
}

/** Python: create_new_skill — shared by POST /create, /id/:id/clone and /import. */
async function createNewSkill(
  user: { id: string; role: string },
  form: Record<string, any>
): Promise<Record<string, any>> {
  if (!(await canEditSkills(user))) err(401, ERROR_MESSAGES.UNAUTHORIZED);

  form['id'] = String(form['id'] ?? '')
    .toLowerCase()
    .replace(/ /g, '-');

  if (!/^[a-z0-9_-]+$/.test(form['id'])) {
    err(400, 'Invalid skill ID');
  }

  if ((await getSkillById(form['id'])) !== null) {
    err(400, EM.ID_TAKEN);
  }

  if (await getSkillByName(String(form['name'] ?? ''))) {
    err(409, 'A skill with this name already exists');
  }

  const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
  form['access_grants'] = await filterAllowedAccessGrants(defaults, user.id, user.role, form['access_grants'] ?? null, 'skill');

  try {
    const skill = await insertNewSkill(user.id, form);
    return skillUserResponse(skill, null);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    err(400, EM.DEFAULT(e, 'Error creating skill'));
  }
}

/** Python: update_skill_by_id router logic — shared by /id/:id/update and /import. */
async function updateSkillRoute(
  user: { id: string; role: string },
  id: string,
  form: Record<string, any>
): Promise<Record<string, any>> {
  const skill = await getSkillById(id);
  if (!skill) err(404, ERROR_MESSAGES.NOT_FOUND);

  if (
    skill.user_id !== user.id &&
    !(await hasAccessGrant(user.id, 'skill', skill.id, 'write')) &&
    !(user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL)
  ) {
    err(401, ERROR_MESSAGES.UNAUTHORIZED);
  }

  const updated: Record<string, any> = {};
  for (const key of ['name', 'description', 'content', 'files', 'data', 'operations', 'expected_version_id', 'commit_message', 'meta', 'is_active']) {
    if (key in form) updated[key] = form[key];
  }

  try {
    const result = await updateSkillById(id, updated, user.id);
    if (result) return skillFullResponse(result);
    err(400, 'Error updating skill');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    err(400, EM.DEFAULT(e, 'Error updating skill'));
  }
}

/** Python: read_import — parse uploaded files (multipart). */
async function readImport(files: Array<{ name: string; bytes: Buffer }>): Promise<Array<Record<string, any>>> {
  const packages: Array<Record<string, any>> = [];
  let total = 0;
  try {
    if (files.length > 10000) throw new Error('Too many uploaded files');
    const folderFiles: Array<{ path: string; content: string; encoding?: 'base64' }> = [];
    for (const file of files) {
      const data = file.bytes;
      total += data.length;
      if (total > MAX_IMPORT_BYTES) throw new Error('Import exceeds 200 MiB');
      if ((file.name ?? '').includes('/')) {
        folderFiles.push({ ...encodeFile(validatePath(file.name), data) });
      } else {
        packages.push(...parseImport(data, file.name ?? ''));
      }
    }
    if (folderFiles.length) {
      const roots = folderFiles
        .filter((f) => f.path.endsWith('/SKILL.md'))
        .map((f) => f.path.slice(0, -'SKILL.md'.length))
        .sort();
      const trimmedRoots = roots.filter((root) => !roots.some((parent) => root !== parent && root.startsWith(parent)));
      if (!trimmedRoots.length) throw new Error('Select a folder containing one or more non-nested skills');
      if (folderFiles.some((f) => !trimmedRoots.some((root) => f.path.startsWith(root)))) {
        throw new Error('Files outside skill directories');
      }
      for (const root of trimmedRoots) {
        const pkg = {
          files: folderFiles
            .filter((f) => f.path.startsWith(root))
            .map((f) => ({ path: f.path.slice(root.length), content: f.content, ...(f.encoding ? { encoding: f.encoding } : {}) })),
        };
        packages.push(...parseImport(Buffer.from(JSON.stringify(pkg), 'utf-8'), 'skill.json'));
      }
    }
    const decoded = packages.reduce((acc, p) => acc + (p['files'] ?? []).reduce((a: number, f: SkillFile) => a + fileBytes(f).length, 0), 0);
    if (decoded > MAX_IMPORT_BYTES) throw new Error('Import exceeds 200 MiB decoded');
    return packages;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    err(400, e instanceof Error ? e.message : String(e));
  }
}

async function requireImport(user: { id: string; role: string }): Promise<void> {
  if (user.role !== 'admin') {
    const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
    if (!(await hasPermission(user.id, 'workspace.skills_import', defaults))) {
      err(403, 'Import permission required');
    }
  }
}

async function readMultipart(ctx: Ctx): Promise<FormData> {
  const form = await ctx.req.formData().catch(() => null);
  if (!form) err(400, 'Error uploading files');
  return form;
}

async function multipartFiles(form: FormData): Promise<Array<{ name: string; bytes: Buffer }>> {
  const fields = form.getAll('files');
  const files: Array<{ name: string; bytes: Buffer }> = [];
  for (const field of fields) {
    if (field instanceof File) {
      files.push({ name: field.name ?? '', bytes: Buffer.from(await field.arrayBuffer()) });
    }
  }
  if (!files.length) err(400, 'Error uploading files');
  return files;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // ------------------- GET / -------------------
  {
    method: 'GET',
    path: '',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const query = ctx.query.get('query');
      let skills = await getSkillsByAccess(user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL ? null : user.id);
      if (query) {
        const q = query.toLowerCase();
        skills = skills.filter((skill) => (skill.name ?? '').toLowerCase().includes(q));
      }
      const owners = new Map(
        (await getUsersByIds([...new Set(skills.map((s) => s.user_id).filter((v): v is string => v !== null))])).map((u) => [u.id, u])
      );
      return ctx.json(skills.map((skill) => skillUserResponse(skill, toUserResponse(owners.get(skill.user_id ?? '') ?? ({} as any)))));
    },
  },

  // ------------------- GET /list -------------------
  {
    method: 'GET',
    path: 'list',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const query = ctx.query.get('query');
      const viewOption = ctx.query.get('view_option');
      const orderBy = ctx.query.get('order_by');
      const direction = ctx.query.get('direction');
      const page = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
      const skip = (page - 1) * PAGE_ITEM_COUNT;

      const bypass = user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL;
      const userGroupIds = await getUserGroupIds(user.id);

      let rows = await getSkillsByAccess(bypass ? null : user.id);

      if (query) {
        const owners = new Map(
          (await getUsersByIds([...new Set(rows.map((s) => s.user_id).filter((v): v is string => v !== null))])).map((u) => [u.id, u])
        );
        const q = query.toLowerCase();
        rows = rows.filter((s) => {
          const owner = owners.get(s.user_id ?? '');
          return (
            (s.name ?? '').toLowerCase().includes(q) ||
            (s.description ?? '').toLowerCase().includes(q) ||
            s.id.toLowerCase().includes(q) ||
            (owner?.name ?? '').toLowerCase().includes(q) ||
            (owner?.email ?? '').toLowerCase().includes(q)
          );
        });
      }
      if (viewOption === 'created') rows = rows.filter((s) => s.user_id === user.id);
      else if (viewOption === 'shared') rows = rows.filter((s) => s.user_id !== user.id);

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
        ? new Set(pageItems.map((s) => s.id))
        : await getAccessibleResourceIds(user.id, 'skill', pageItems.map((s) => s.id), 'write', userGroupIds);

      const owners = new Map(
        (await getUsersByIds([...new Set(pageItems.map((s) => s.user_id).filter((v): v is string => v !== null))])).map((u) => [u.id, u])
      );

      const items = pageItems.map((skill) => ({
        ...skillUserResponse(skill, toUserResponse(owners.get(skill.user_id ?? '') ?? ({} as any))),
        write_access: bypass || user.id === skill.user_id || writable.has(skill.id),
      }));

      return ctx.json({ items, total });
    },
  },

  // ------------------- GET /export -------------------
  {
    method: 'GET',
    path: 'export',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const format = ctx.query.get('format') ?? 'json';
      const ids = ctx.query.getAll('ids');
      const versionId = ctx.query.get('version_id');

      if (user.role !== 'admin') {
        const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
        if (!(await hasPermission(user.id, 'workspace.skills_export', defaults))) {
          err(403, 'Export permission required');
        }
      }
      if (versionId && (!ids.length || ids.length !== 1)) {
        err(400, 'Select one skill to export a historical version');
      }
      if (format === 'skill' && (!ids.length || ids.length !== 1)) {
        err(400, 'Select one skill to export as .skill');
      }

      const skills: SkillModel[] = [];
      if (ids.length) {
        for (const id of ids) skills.push(await authorizedSkill(id, user));
      } else {
        skills.push(...(await getSkillsByAccess(user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL ? null : user.id)));
      }

      const packages: Array<Record<string, any>> = [];
      for (const skill of skills) {
        const snapshot = await getSkillSnapshot(skill, versionId);
        packages.push({
          id: skill.id,
          name: snapshot['name'],
          description: snapshot['description'],
          meta: snapshot['meta'],
          files: snapshot['data']['files'],
          is_active: skill.is_active,
        });
      }

      if (format === 'zip' || format === 'skill') {
        const filename = format === 'skill' ? `${skills[0].id}.skill` : 'skills.zip';
        const bytes = zipExport(packages);
        return new Response(new Uint8Array(bytes), {
          status: 200,
          headers: {
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename="${filename}"`,
          },
        });
      }
      if (format !== 'json') err(400, 'Export format must be json, zip, or skill');
      return ctx.json(ids.length === 1 ? packages[0] : packages);
    },
  },

  // ------------------- POST /create -------------------
  {
    method: 'POST',
    path: 'create',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const form = await ctx.body<Record<string, any>>();
      return ctx.json(await createNewSkill(user, form));
    },
  },

  // ------------------- GET /id/:id -------------------
  {
    method: 'GET',
    path: 'id/:id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const skill = await getSkillById(ctx.params.id);
      if (!skill) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (
        (user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL) ||
        skill.user_id === user.id ||
        (await hasAccessGrant(user.id, 'skill', skill.id, 'read'))
      ) {
        const writeAccess =
          (user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL) ||
          user.id === skill.user_id ||
          (await hasAccessGrant(user.id, 'skill', skill.id, 'write'));
        return ctx.json({
          ...skillUserResponse(skill, null),
          content: skill.content,
          write_access: writeAccess,
        });
      }
      err(401, ERROR_MESSAGES.ACCESS_PROHIBITED);
    },
  },

  // ------------------- POST /id/:id/update -------------------
  {
    method: 'POST',
    path: 'id/:id/update',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const form = await ctx.body<Record<string, any>>();
      return ctx.json(await updateSkillRoute(user, ctx.params.id, form));
    },
  },

  // ------------------- POST /id/:id/access/update -------------------
  {
    method: 'POST',
    path: 'id/:id/access/update',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const form = await ctx.body<{ access_grants?: any[] }>();

      const skill = await getSkillById(id);
      if (!skill) err(404, ERROR_MESSAGES.NOT_FOUND);

      if (
        skill.user_id !== user.id &&
        !(await hasAccessGrant(user.id, 'skill', skill.id, 'write')) &&
        !(user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL)
      ) {
        err(401, ERROR_MESSAGES.UNAUTHORIZED);
      }

      const defaults = await configGet<Record<string, any> | null>('user.permissions', null);
      const grants = await validateAccessGrants(defaults, user.id, user.role, form.access_grants ?? [], 'skill');

      await setAccessGrants('skill', id, grants);

      const updated = await getSkillById(id);
      return ctx.json(updated ? skillFullResponse(updated) : null);
    },
  },

  // ------------------- POST /id/:id/toggle -------------------
  {
    method: 'POST',
    path: 'id/:id/toggle',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const skill = await getSkillById(id);
      if (!skill) err(404, ERROR_MESSAGES.NOT_FOUND);
      if (
        (user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL) ||
        skill.user_id === user.id ||
        (await hasAccessGrant(user.id, 'skill', skill.id, 'write'))
      ) {
        const toggled = await toggleSkillById(id);
        if (toggled) return ctx.json(skillFullResponse(toggled));
        err(400, 'Error toggling skill');
      }
      err(401, ERROR_MESSAGES.UNAUTHORIZED);
    },
  },

  // ------------------- DELETE /id/:id/delete -------------------
  {
    method: 'DELETE',
    path: 'id/:id/delete',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const skill = await getSkillById(id);
      if (!skill) err(404, ERROR_MESSAGES.NOT_FOUND);

      if (
        skill.user_id !== user.id &&
        !(await hasAccessGrant(user.id, 'skill', skill.id, 'write')) &&
        !(user.role === 'admin' && BYPASS_ADMIN_ACCESS_CONTROL)
      ) {
        err(401, ERROR_MESSAGES.UNAUTHORIZED);
      }

      return ctx.json(await deleteSkillById(id));
    },
  },

  // ------------------- GET /id/:id/files -------------------
  {
    method: 'GET',
    path: 'id/:id/files',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const skill = await authorizedSkill(ctx.params.id, user);
      const versionId = ctx.query.get('version_id');
      const snapshot = await getSkillSnapshot(skill, versionId);
      return ctx.json({
        version_id: versionId ?? skill.version_id,
        files: fileSummaries(snapshot['data']['files']),
      });
    },
  },

  // ------------------- GET /id/:id/files/content -------------------
  {
    method: 'GET',
    path: 'id/:id/files/content',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const path = ctx.query.get('path') ?? '';
      const versionId = ctx.query.get('version_id');
      const skill = await authorizedSkill(ctx.params.id, user);
      const snapshot = await getSkillSnapshot(skill, versionId);
      const file = (snapshot['data']['files'] as SkillFile[]).find((f) => f.path === path);
      if (!file) err(404, 'File not found');
      const bytes = fileBytes(file);
      const mimeByExt: Record<string, string> = {
        '.md': 'text/markdown',
        '.txt': 'text/plain',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
        '.py': 'text/x-python',
        '.js': 'text/javascript',
        '.html': 'text/html',
        '.css': 'text/css',
        '.csv': 'text/csv',
        '.yaml': 'text/yaml',
        '.yml': 'text/yaml',
      };
      const ext = path.includes('.') ? `.${path.split('.').pop()!.toLowerCase()}` : '';
      const mediaType = mimeByExt[ext] ?? 'application/octet-stream';
      const filename = encodeURIComponent(path.split('/').pop() ?? path);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'content-type': mediaType,
          'content-disposition': `attachment; filename*=UTF-8''${filename}`,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'cache-control': 'private, no-store',
        },
      });
    },
  },

  // ------------------- GET /id/:id/history -------------------
  {
    method: 'GET',
    path: 'id/:id/history',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await authorizedSkill(ctx.params.id, user);
      const page = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
      return ctx.json(await getSkillHistoryBySkillId(ctx.params.id, page));
    },
  },

  // ------------------- GET /id/:id/history/diff/file (before :history_id) -------------------
  {
    method: 'GET',
    path: 'id/:id/history/diff/file',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const fromId = ctx.query.get('from_id') ?? '';
      const toId = ctx.query.get('to_id') ?? '';
      const path = ctx.query.get('path') ?? '';
      const skill = await authorizedSkill(ctx.params.id, user);
      const entries = [await selectedHistory(skill, fromId), await selectedHistory(skill, toId)];
      const files = entries.map((entry) =>
        ((entry.snapshot['data']['files'] ?? []) as SkillFile[]).find((f) => f.path === path) ?? null
      );
      if (!files.some(Boolean)) err(404, 'File not found');
      if (files.some((f) => f && f.encoding)) {
        return ctx.json({ binary: true });
      }
      const before = files[0]?.content ?? '';
      const after = files[1]?.content ?? '';
      const diff = unifiedDiff(before, after, `${fromId.slice(0, 7)}/${path}`, `${toId.slice(0, 7)}/${path}`);
      return ctx.json({
        binary: false,
        diff,
        line_endings_only: !diff && before !== after,
      });
    },
  },

  // ------------------- GET /id/:id/history/diff (before :history_id) -------------------
  {
    method: 'GET',
    path: 'id/:id/history/diff',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const fromId = ctx.query.get('from_id') ?? '';
      const toId = ctx.query.get('to_id') ?? '';
      const skill = await authorizedSkill(ctx.params.id, user);
      const before = (await selectedHistory(skill, fromId)).snapshot;
      const after = (await selectedHistory(skill, toId)).snapshot;
      const a = new Map(((before['data']['files'] ?? []) as SkillFile[]).map((f) => [f.path, f]));
      const b = new Map(((after['data']['files'] ?? []) as SkillFile[]).map((f) => [f.path, f]));
      const metadata: Record<string, any> = {};
      for (const k of ['name', 'description', 'meta']) {
        if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) {
          metadata[k] = { before: before[k] ?? null, after: after[k] ?? null };
        }
      }
      const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
      const fileDiffs = paths
        .filter((p) => JSON.stringify(a.get(p) ?? null) !== JSON.stringify(b.get(p) ?? null))
        .map((p) => ({
          path: p,
          status: !a.has(p) ? 'added' : !b.has(p) ? 'deleted' : 'modified',
          binary: Boolean(a.get(p)?.encoding || b.get(p)?.encoding),
        }));
      return ctx.json({ metadata, files: fileDiffs });
    },
  },

  // ------------------- GET /id/:id/history/:history_id -------------------
  {
    method: 'GET',
    path: 'id/:id/history/:history_id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const skill = await authorizedSkill(ctx.params.id, user);
      const entry = await selectedHistory(skill, ctx.params.history_id);
      const snapshot = entry.snapshot;
      return ctx.json({
        id: entry.id,
        skill_id: entry.skill_id,
        parent_id: entry.parent_id,
        user_id: entry.user_id,
        commit_message: entry.commit_message,
        created_at: entry.created_at,
        user: entry.user,
        snapshot: {
          ...Object.fromEntries(Object.entries(snapshot).filter(([k]) => k !== 'data')),
          data: { files: fileSummaries(snapshot['data']['files']) },
        },
      });
    },
  },

  // ------------------- DELETE /id/:id/history/:history_id -------------------
  {
    method: 'DELETE',
    path: 'id/:id/history/:history_id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await authorizedSkill(ctx.params.id, user, 'write');
      if (!(await deleteSkillHistoryEntry(ctx.params.id, ctx.params.history_id))) {
        err(404, 'Version not found');
      }
      return ctx.json(true);
    },
  },

  // ------------------- POST /id/:id/update/version -------------------
  {
    method: 'POST',
    path: 'id/:id/update/version',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await authorizedSkill(ctx.params.id, user, 'write');
      const form = await ctx.body<{ version_id?: string; expected_version_id?: string }>();
      const result = await updateSkillVersion(ctx.params.id, String(form.version_id ?? ''), String(form.expected_version_id ?? ''));
      if (!result) err(404, 'Skill not found');
      return ctx.json(skillFullResponse(result!));
    },
  },

  // ------------------- POST /id/:id/clone -------------------
  {
    method: 'POST',
    path: 'id/:id/clone',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const form = await ctx.body<{ id?: string; name?: string; version_id?: string | null }>();
      const skill = await authorizedSkill(ctx.params.id, user);
      const snapshot = await getSkillSnapshot(skill, form.version_id ?? null);
      const data = {
        ...snapshot,
        id: form.id,
        name: form.name,
        is_active: skill.is_active,
        access_grants: [],
      };
      return ctx.json(await createNewSkill(user, data));
    },
  },

  // ------------------- POST /load/url -------------------
  {
    method: 'POST',
    path: 'load/url',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<{ url?: string }>();
      try {
        return ctx.json(await loadSkillFromUrl(String(form.url ?? '')));
      } catch (e) {
        err(400, e instanceof Error ? e.message : String(e));
      }
    },
  },

  // ------------------- POST /import/preview -------------------
  {
    method: 'POST',
    path: 'import/preview',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await requireImport(user);
      const form = await readMultipart(ctx);
      const files = await multipartFiles(form);
      const packages = await readImport(files);
      const results: Array<Record<string, any>> = [];
      for (let index = 0; index < packages.length; index++) {
        const pkg = packages[index];
        const existing = await getSkillById(String(pkg['id']));
        let writable = false;
        if (existing) {
          try {
            await authorizedSkill(existing.id, user, 'write');
            writable = true;
          } catch {
            writable = false;
          }
        }
        results.push({
          index,
          ...Object.fromEntries(Object.entries(pkg).filter(([k]) => k !== 'files')),
          files: fileSummaries(pkg['files']),
          id_taken: existing !== null,
          name_taken: (await getSkillByName(String(pkg['name']))) !== null,
          can_replace: writable,
          expected_version_id: writable ? existing!.version_id : null,
        });
      }
      return ctx.json(results);
    },
  },

  // ------------------- POST /import -------------------
  {
    method: 'POST',
    path: 'import',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      await requireImport(user);
      const form = await readMultipart(ctx);
      const files = await multipartFiles(form);
      const packages = await readImport(files);
      const decisionsField = form.get('decisions');
      const decisions = typeof decisionsField === 'string' ? decisionsField : null;
      let choices: Array<Record<string, any>>;
      try {
        choices = decisions ? JSON.parse(decisions) : null;
        if (!Array.isArray(choices) || choices.length !== packages.length || choices.some((c) => !c || typeof c !== 'object')) {
          throw new Error('One decision is required per skill');
        }
      } catch (e) {
        err(400, e instanceof Error ? e.message : String(e));
      }

      const results: Array<Record<string, any>> = [];
      for (let i = 0; i < packages.length; i++) {
        const pkg = packages[i];
        const choice = choices[i];
        try {
          const action = choice['action'] ?? 'skip';
          if (action === 'skip') {
            results.push({ status: 'skipped', id: pkg['id'] });
            continue;
          }
          const data = {
            ...pkg,
            id: choice['id'] ?? pkg['id'],
            name: choice['name'] ?? pkg['name'],
          };
          let result: Record<string, any>;
          if (action === 'replace') {
            await authorizedSkill(String(data['id']), user, 'write');
            if (!choice['expected_version_id']) {
              err(400, 'Replacement requires expected_version_id');
            }
            result = await updateSkillRoute(user, String(data['id']), {
              ...data,
              expected_version_id: choice['expected_version_id'],
            });
          } else if (action === 'create' || action === 'copy') {
            result = await createNewSkill(user, { ...data, access_grants: [] });
          } else {
            err(400, 'Unknown import action');
          }
          results.push({ status: 'saved', id: result['id'] });
        } catch (e) {
          results.push({
            status: 'error',
            id: pkg['id'],
            error: e instanceof HttpError ? e.detail : String(e),
          });
        }
      }
      return ctx.json(results);
    },
  },
];
