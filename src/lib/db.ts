import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Database client — Supabase Postgres via Prisma (default) or local SQLite
 * (experiment mode).
 *
 * Default: Nelth-AI runs on the hosted Supabase Postgres database (session
 * pooler):
 *
 *   DATABASE_URL=postgres://…pooler.supabase.com:5432/postgres?sslmode=require
 *
 * The schema (prisma/schema.prisma) is the ported Open WebUI v0.12.5 table
 * layout (45 tables, exact Python column names). Each account keeps its own
 * ID (Firebase UID for Firebase-bridged accounts) and its rows — chats,
 * messages, files, memories… — are keyed by that ID in Supabase.
 *
 * EXPERIMENT — "without Supabase": set NELTH_DB_SQLITE=1 in .env to run the
 * whole app on the LOCAL SQLite file db/custom.db (schema variant
 * prisma/schema.sqlite.prisma). Purpose: measure how much of the local
 * latency comes from the remote Supabase round-trips. Remove the flag (and
 * run `bun scripts/prisma.mjs generate`) to go back to Supabase — the
 * Supabase data is never touched by this mode.
 */

/** Read a boolean flag from the ambient env, then from the .env file. */
function readEnvFlag(name: string): boolean {
  const ambient = process.env[name]
  if (typeof ambient === 'string' && ambient.trim() !== '') {
    const v = ambient.trim().toLowerCase()
    return v !== '0' && v !== 'false'
  }
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8')
    const match = raw.match(new RegExp(`^${name}=(.*)$`, 'm'))
    if (match) {
      const v = match[1].trim().toLowerCase()
      return v !== '' && v !== '0' && v !== 'false'
    }
  } catch {
    /* .env unreadable */
  }
  return false
}

/** Experiment mode: run on the local SQLite file instead of Supabase. */
export const IS_SQLITE = readEnvFlag('NELTH_DB_SQLITE')

/** SQLite target file — ambient `file:`… URL, then .env, then the default. */
function resolveSqliteUrl(): string {
  const ambient = process.env.DATABASE_URL ?? ''
  if (ambient.startsWith('file:')) return ambient
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8')
    const match = raw.match(/^DATABASE_URL=(.+)$/m)
    const url = match ? match[1].trim() : ''
    if (url.startsWith('file:')) return url
  } catch {
    /* .env unreadable */
  }
  return `file:${path.join(process.cwd(), 'db', 'custom.db')}`
}

/**
 * Resolve the datasource URL.
 *
 * SQLite mode (NELTH_DB_SQLITE=1): the local file:… URL — Supabase is fully
 * bypassed.
 *
 * Postgres mode, resolution order:
 *   1. process.env.DATABASE_URL when it is already a Postgres URL — the
 *      standard configuration path (Vercel/Docker/CI all set it directly).
 *   2. otherwise, the DATABASE_URL from the .env file — the dev sandbox
 *      exports a stale SQLite `file:`… value into the ambient environment
 *      (process env always wins over .env in Next.js), and the Supabase
 *      URL in .env is the single source of truth.
 */
function resolveDatabaseUrl(): string {
  if (IS_SQLITE) {
    const sqliteUrl = resolveSqliteUrl()
    process.env.DATABASE_URL = sqliteUrl
    return sqliteUrl
  }
  const ambient = process.env.DATABASE_URL ?? ''
  if (/^postgres(ql)?:\/\//.test(ambient)) return ambient

  try {
    const envPath = path.join(process.cwd(), '.env')
    const raw = fs.readFileSync(envPath, 'utf8')
    const match = raw.match(/^DATABASE_URL=(.+)$/m)
    const url = match ? match[1].trim() : ''
    if (/^postgres(ql)?:\/\//.test(url)) {
      if (ambient) {
        console.warn(
          `[db] ambient DATABASE_URL (${ambient.slice(0, 12)}…) is not Postgres — using the Supabase URL from .env`
        )
      }
      process.env.DATABASE_URL = url
      return url
    }
  } catch {
    // .env unreadable — keep the ambient value (fails loudly at first query)
  }
  return ambient
}

const databaseUrl = resolveDatabaseUrl()

/**
 * RUNTIME datasource URL — pooler per environment (Postgres mode only).
 *
 * Two constraints pull in opposite directions:
 *
 * • SERVERLESS (Vercel): horizontal instances × a pool exhaust the SESSION
 *   pooler's shared 15-client budget (reproduced:
 *   EMAXCONNSESSION → empty 500s). The TRANSACTION pooler (6543) multiplexes
 *   every client over a shared backend pool — the serverless mode. In-region
 *   (Vercel us-east-1 → Supabase us-east-1) its per-query overhead is a few ms.
 *
 * • LOCAL/SELF-HOSTED far from the DB: the transaction pooler costs
 *   ~1s PER QUERY over a long network path (measured from the dev sandbox:
 *   989 ms/query on 6543 vs 213 ms on 5432 — a single warm findUnique), while
 *   the session pooler's per-query cost is one network roundtrip. A dev
 *   server is ONE process with its own small pool — the shared-budget
 *   exhaustion does not apply — so session mode is both safe AND 4-5× faster
 *   per query.
 *
 * Selection: VERCEL (or NELTH_DB_TRANSACTION_POOLER=1) → 6543 transaction;
 * otherwise (or NELTH_DB_SESSION_POOLER=1) → 5432 session + pool cap.
 * `prisma db push` (CLI) keeps using the session-mode .env URL — the
 * transform lives ONLY in this runtime client.
 */
function runtimeDatasourceUrl(url: string): string {
  if (!url || IS_SQLITE) return url
  const isSupabasePooler = () => {
    try {
      const u = new URL(/^postgres:\/\//.test(url) ? url.replace(/^postgres:/, 'postgresql:') : url)
      return /\.pooler\.supabase\.com$/i.test(u.hostname)
    } catch {
      return false
    }
  }
  if (!isSupabasePooler()) return capConnectionPool(url)
  const wantTransaction =
    process.env.NELTH_DB_TRANSACTION_POOLER === '1' ||
    (process.env.VERCEL && process.env.NELTH_DB_SESSION_POOLER !== '1')
  try {
    const u = new URL(/^postgres:\/\//.test(url) ? url.replace(/^postgres:/, 'postgresql:') : url)
    if (wantTransaction) {
      if (u.port === '' || u.port === '5432') u.port = '6543'
      u.searchParams.set('pgbouncer', 'true')
      u.searchParams.set('connection_limit', '5')
      u.searchParams.delete('pool_timeout') // multiplexed — no hard slot budget
      return u.toString()
    }
    return capConnectionPool(url) // session mode stays on 5432
  } catch {
    /* unparsable — fall through to the plain cap */
  }
  return capConnectionPool(url)
}

/**
 * Cap the Prisma connection pool (session mode / non-Supabase URLs).
 * A small per-client cap keeps every instance under the server budget;
 * bursts beyond the cap queue briefly (pool_timeout) instead of erroring.
 */
function capConnectionPool(url: string): string {
  if (!url) return url
  if (/[?&]connection_limit=/.test(url)) return url // explicit override wins
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=3&pool_timeout=10`
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    ...(databaseUrl ? { datasources: { db: { url: runtimeDatasourceUrl(databaseUrl) } } } : {}),
    log: process.env.PRISMA_LOG === 'query' ? ['query'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// ---------------------------------------------------------------------------
// Dialect helpers for the raw-SQL call sites (experiment: SQLite vs Postgres)
// ---------------------------------------------------------------------------

/**
 * Postgres raw queries bind parameters as $1, $2, …; SQLite wants the
 * positional `?` marker. Every $N appears exactly once, in ascending order,
 * matching the argument order at the call sites — a plain rewrite is safe.
 */
function toDialectPlaceholders(sql: string): string {
  return IS_SQLITE ? sql.replace(/\$(\d+)/g, '?') : sql
}

/** Dialect-safe replacement for db.$queryRawUnsafe. */
export async function queryUnsafe<T = unknown>(sql: string, ...args: unknown[]): Promise<T> {
  return db.$queryRawUnsafe<T>(toDialectPlaceholders(sql), ...args)
}

/** Dialect-safe replacement for db.$executeRawUnsafe. */
export async function execUnsafe(sql: string, ...args: unknown[]): Promise<number> {
  return db.$executeRawUnsafe(toDialectPlaceholders(sql), ...args)
}
