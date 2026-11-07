#!/usr/bin/env bun
/**
 * Prisma wrapper — picks the schema matching the resolved DATABASE_URL and
 * forwards the command to the Prisma CLI:
 *
 *   DATABASE_URL = postgres://… → prisma/schema.postgres.prisma (production:
 *                                  Vercel/Supabase, Docker-with-Postgres)
 *   DATABASE_URL = file:… / unset → prisma/schema.prisma          (SQLite:
 *                                  local sandbox, self-hosted default)
 *
 * URL resolution mirrors src/lib/db.ts exactly:
 *   1. process.env.DATABASE_URL when it is already a Postgres URL;
 *   2. otherwise the DATABASE_URL from .env when it is Postgres;
 *   3. otherwise whatever ambient value is set (file:…, empty).
 *
 * The client is generated to the DEFAULT location (@prisma/client) for both
 * variants, so `import { db } from '@/lib/db'` works unchanged everywhere.
 *
 * Usage:
 *   bun scripts/prisma.mjs generate                 # always regenerate
 *   bun scripts/prisma.mjs ensure                   # regenerate ONLY when the
 *                                                   # generated client's provider
 *                                                   # mismatches the URL (used at
 *                                                   # container/dev startup)
 *   bun scripts/prisma.mjs db push --accept-data-loss
 *   bun scripts/prisma.mjs migrate dev
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_POSTGRES_RE = /^postgres(ql)?:\/\//;

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
    // .env unreadable — keep the ambient value
  }
  return ambient;
}

const url = resolveDatabaseUrl();
const isPostgres = IS_POSTGRES_RE.test(url);
const schema = path.join('prisma', isPostgres ? 'schema.postgres.prisma' : 'schema.prisma');

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

// `ensure` — regenerate only on provider mismatch (startup self-heal).
if (command === 'ensure') {
  const want = isPostgres ? 'postgresql' : 'sqlite';
  const have = generatedProvider();
  if (have === want) {
    console.log(`[prisma] client already ${want} — nothing to do`);
    process.exit(0);
  }
  console.log(
    `[prisma] generated client is "${have || 'absent'}" but DATABASE_URL needs "${want}" — regenerating`
  );
}

console.log(
  `[prisma] provider=${isPostgres ? 'postgresql' : 'sqlite'} → ${path.relative(ROOT, schema)}`
);

// Forward to the Prisma CLI (runs under bun or node — process.execPath works
// for both; the CLI entry is a plain JS file).
const prismaCli = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
if (!fs.existsSync(prismaCli)) {
  console.error('[prisma] node_modules/prisma not installed — run `bun install` first');
  process.exit(1);
}

const args = command === 'ensure' ? ['generate'] : process.argv.slice(2);
const result = spawnSync(process.execPath, [prismaCli, ...args, '--schema', schema], {
  cwd: ROOT,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
