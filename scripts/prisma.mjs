#!/usr/bin/env bun
/**
 * Prisma wrapper — single Supabase Postgres schema (prisma/schema.prisma),
 * forwarded to the Prisma CLI:
 *
 *   DATABASE_URL = postgres://… (Supabase) everywhere — production (Vercel)
 *                  AND local development. There is no SQLite variant anymore.
 *
 * URL resolution mirrors src/lib/db.ts:
 *   1. process.env.DATABASE_URL when it is already a Postgres URL;
 *   2. otherwise the DATABASE_URL from .env (the sandbox shell exports a
 *      stale `file:`… value that would otherwise win over .env).
 * The resolved URL is re-exported to the CLI child so `db push`/`migrate`
 * always target Supabase.
 *
 * Usage:
 *   bun scripts/prisma.mjs generate
 *   bun scripts/prisma.mjs ensure        # regenerate ONLY when the generated
 *                                        # client's provider is not postgresql
 *   bun scripts/prisma.mjs db push --accept-data-loss
 *   bun scripts/prisma.mjs migrate dev
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_POSTGRES_RE = /^postgres(ql)?:\/\//;
const SCHEMA = path.join('prisma', 'schema.prisma');

/** Same resolution order as src/lib/db.ts (quotes stripped). */
function resolveDatabaseUrl() {
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
if (!IS_POSTGRES_RE.test(url)) {
  console.error(
    '[prisma] DATABASE_URL is not a Postgres URL — the app runs on Supabase ' +
      'Postgres only. Set DATABASE_URL=postgres://… in .env (cf. .env.example).'
  );
  process.exit(1);
}
// Make sure the CLI child sees the Supabase URL (the ambient env may still
// carry a stale file:… value that would take precedence).
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

// `ensure` — regenerate only when the client is not the Postgres one
// (startup self-heal, e.g. after a fresh install with a stale client).
if (command === 'ensure') {
  if (generatedProvider() === 'postgresql') {
    console.log('[prisma] client already postgresql — nothing to do');
    process.exit(0);
  }
  console.log(
    `[prisma] generated client is "${generatedProvider() || 'absent'}" but postgresql is required — regenerating`
  );
}

console.log(`[prisma] provider=postgresql → ${SCHEMA}`);

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
// object so the CLI reliably sees the resolved Supabase URL.
const childEnv = { ...process.env, DATABASE_URL: url };
const result = spawnSync(process.execPath, [prismaCli, ...args, '--schema', SCHEMA], {
  cwd: ROOT,
  env: childEnv,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
