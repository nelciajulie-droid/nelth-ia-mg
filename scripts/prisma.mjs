#!/usr/bin/env bun
/**
 * Prisma wrapper — dual dialect:
 *
 *   • DEFAULT: Supabase Postgres (prisma/schema.prisma) — production (Vercel)
 *     and normal local development.
 *   • EXPERIMENT "without Supabase" (NELTH_DB_SQLITE=1 in .env or ambient):
 *     local SQLite file (prisma/schema.sqlite.prisma → db/custom.db). Used to
 *     measure how much of the local latency comes from the remote Supabase
 *     round-trips. Remove the flag and run `bun scripts/prisma.mjs generate`
 *     to go back to the Postgres client.
 *
 * URL resolution mirrors src/lib/db.ts (quotes stripped):
 *   SQLite mode: ambient `file:`… URL, then .env `file:`… URL, then the
 *                default file:<ROOT>/db/custom.db.
 *   Postgres:    1. process.env.DATABASE_URL when it is already a Postgres URL;
 *                2. otherwise the DATABASE_URL from .env (the sandbox shell
 *                   exports a stale `file:`… value that would win over .env).
 * The resolved URL is re-exported to the CLI child so `db push`/`migrate`
 * always target the intended database.
 *
 * Usage:
 *   bun scripts/prisma.mjs generate
 *   bun scripts/prisma.mjs ensure        # regenerate ONLY when the generated
 *                                        # client's provider mismatches the mode
 *   bun scripts/prisma.mjs db push --accept-data-loss
 *   bun scripts/prisma.mjs migrate dev
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_POSTGRES_RE = /^postgres(ql)?:\/\//;

/** Read a boolean flag from the ambient env, then from the .env file. */
function readEnvFlag(name) {
  const ambient = process.env[name];
  if (typeof ambient === 'string' && ambient.trim() !== '') {
    const v = ambient.trim().toLowerCase();
    return v !== '0' && v !== 'false';
  }
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const match = raw.match(new RegExp(`^${name}=(.*)$`, 'm'));
    if (match) {
      const v = match[1].trim().toLowerCase();
      return v !== '' && v !== '0' && v !== 'false';
    }
  } catch {
    /* .env unreadable */
  }
  return false;
}

const SQLITE_MODE = readEnvFlag('NELTH_DB_SQLITE');
const PROVIDER = SQLITE_MODE ? 'sqlite' : 'postgresql';
const SCHEMA = SQLITE_MODE
  ? path.join('prisma', 'schema.sqlite.prisma')
  : path.join('prisma', 'schema.prisma');

function resolveSqliteUrl() {
  const ambient = process.env.DATABASE_URL ?? '';
  if (ambient.startsWith('file:')) return ambient;
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const match = raw.match(/^DATABASE_URL=(.+)$/m);
    const url = match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
    if (url.startsWith('file:')) return url;
  } catch {
    /* .env unreadable */
  }
  return `file:${path.join(ROOT, 'db', 'custom.db')}`;
}

/** Same resolution order as src/lib/db.ts (quotes stripped). */
function resolveDatabaseUrl() {
  if (SQLITE_MODE) return resolveSqliteUrl();
  const ambient = process.env.DATABASE_URL ?? '';
  if (IS_POSTGRES_RE.test(ambient)) return ambient;

  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const match = raw.match(/^DATABASE_URL=(.+)$/m);
    const url = match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
    if (IS_POSTGRES_RE.test(url)) return url;
  } catch {
    // .env unreadable — keep the ambient value (fails loudly at first query)
  }
  return ambient;
}

const url = resolveDatabaseUrl();
const urlOk = SQLITE_MODE ? url.startsWith('file:') : IS_POSTGRES_RE.test(url);
if (!urlOk) {
  console.error(
    `[prisma] DATABASE_URL (${url.slice(0, 24) || 'empty'}) does not match the mode ` +
      `(${PROVIDER}). Set DATABASE_URL accordingly in .env (cf. .env.example).`
  );
  process.exit(1);
}
// Make sure the CLI child sees the resolved URL (the ambient env may still
// carry a stale value that would take precedence).
process.env.DATABASE_URL = url;

/** Provider baked into the currently generated client (node_modules/.prisma). */
function generatedProvider() {
  try {
    const marker = fs.readFileSync(
      path.join(ROOT, 'node_modules', '.prisma', 'client', 'schema.prisma'),
      'utf8'
    );
    return marker.match(/provider\s*=\s*"(\w+)"/)?.[1] ?? '';
  } catch {
    return ''; // not generated yet
  }
}

const command = process.argv[2] ?? 'generate';

// `ensure` — regenerate only when the client does not match the mode
// (startup self-heal, e.g. after a fresh install with a stale client).
if (command === 'ensure') {
  if (generatedProvider() === PROVIDER) {
    console.log(`[prisma] client already ${PROVIDER} — nothing to do`);
    process.exit(0);
  }
  console.log(
    `[prisma] generated client is "${generatedProvider() || 'absent'}" but ${PROVIDER} is required — regenerating`
  );
}

console.log(`[prisma] provider=${PROVIDER} → ${SCHEMA} (${url.replace(/:[^:@/]*@/, ':***@')})`);

// Forward to the Prisma CLI (runs under bun or node — process.execPath works
// for both; the CLI entry is a plain JS file).
const prismaCli = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
if (!fs.existsSync(prismaCli)) {
  console.error('[prisma] node_modules/prisma not installed — run `bun install` first');
  process.exit(1);
}

const args = command === 'ensure' ? ['generate'] : process.argv.slice(2);
// NB: under Bun, spawnSync WITHOUT `env:` forwards the STARTUP environment
// snapshot — mutations of process.env are NOT propagated. Build a fresh env
// object so the CLI reliably sees the resolved URL.
const childEnv = { ...process.env, DATABASE_URL: url };
const result = spawnSync(process.execPath, [prismaCli, ...args, '--schema', SCHEMA], {
  cwd: ROOT,
  env: childEnv,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
