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
 * Cap the Prisma connection pool (Supabase session pooler hard limit).
 *
 * The session pooler (port 5432, pgbouncer session mode) allows a TOTAL of
 * ~15 server-side client slots for the whole database — shared by EVERY app
 * instance pointing at it (local dev server + each serverless function
 * instance). Prisma's default pool (num_cpus×2+1, up to 17+ on a big host)
 * can single-handedly exhaust the pooler: intermittent
 * `FATAL: (EMAXCONNSESSION) max clients reached in session mode - pool_size:
 * 15` on the first query of a request (auth lookup → empty 500). A small
 * per-client cap keeps every instance well under the shared budget; bursts
 * beyond the cap queue briefly (pool_timeout) instead of erroring.
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
    ...(databaseUrl ? { datasources: { db: { url: capConnectionPool(databaseUrl) } } } : {}),
    log: process.env.PRISMA_LOG === 'query' ? ['query'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
