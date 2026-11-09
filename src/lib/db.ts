import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Database client — Supabase Postgres via Prisma.
 *
 * Nelth-AI runs on the hosted Supabase Postgres database (session pooler):
 *
 *   DATABASE_URL=postgres://…pooler.supabase.com:5432/postgres?sslmode=require
 *
 * The schema (prisma/schema.prisma) is the ported Open WebUI v0.12.5 table
 * layout (45 tables, exact Python column names). Each account keeps its own
 * ID (Firebase UID for Firebase-bridged accounts) and its rows — chats,
 * messages, files, memories… — are keyed by that ID in Supabase.
 *
 * There is NO SQLite fallback anymore: local development and production both
 * use this same Supabase instance.
 */

/**
 * Resolve the Postgres datasource URL.
 *
 * Resolution order:
 *   1. process.env.DATABASE_URL when it is already a Postgres URL — the
 *      standard configuration path (Vercel/Docker/CI all set it directly).
 *   2. otherwise, the DATABASE_URL from the .env file — the dev sandbox
 *      exports a stale SQLite `file:`… value into the ambient environment
 *      (process env always wins over .env in Next.js), and the Supabase
 *      URL in .env is the single source of truth.
 */
function resolveDatabaseUrl(): string {
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
 * RUNTIME datasource URL — pooler per environment.
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
  if (!url) return url
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
