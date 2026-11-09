import { db } from '@/lib/db';

/**
 * Port of the PersistentConfig system (open_webui/models/config.py).
 *
 * Resolution order (same as Python):
 *   1. value stored in the `config` table (persisted at runtime by admins)
 *   2. environment variable default (see constants.ts `env`)
 *
 * Values are stored as TEXT in the `config` table (data column) exactly like
 * Python's PersistentConfig (JSON-encoded).
 */

// ---------------------------------------------------------------------------
// Read cache — a chat turn resolves ~15 config keys (skills, web search,
// image/video autos, permissions…), each a full DB roundtrip when uncached.
// From far regions that is SECONDS of pure latency before the first token
// (measured: +8s pre-decision on the dev sandbox); on serverless it still
// stacks ~0.5-1s per turn. A short TTL cache collapses the whole phase to
// one roundtrip per key per window; configSet writes through and busts the
// key so admin changes propagate on the next read (≤TTL on other
// instances).
// ---------------------------------------------------------------------------

const CONFIG_CACHE_TTL_MS = 60_000;
type CacheEntry = { found: boolean; value: unknown; at: number };
const configCache = new Map<string, CacheEntry>();
const configInFlight = new Map<string, Promise<CacheEntry>>();

async function readConfigRow(key: string): Promise<CacheEntry> {
  const cached = configCache.get(key);
  if (cached && Date.now() - cached.at < CONFIG_CACHE_TTL_MS) return cached;
  const existing = configInFlight.get(key);
  if (existing) return existing;
  const load = (async (): Promise<CacheEntry> => {
    try {
      const row = (await db.config.findUnique({ where: { key } })) as ConfigRow | null;
      if (row) {
        let value: unknown;
        try {
          value = JSON.parse(row.value);
        } catch {
          value = row.value;
        }
        return { found: true, value, at: Date.now() };
      }
      return { found: false, value: undefined, at: Date.now() };
    } catch {
      // table might not exist yet during bootstrap — negative entry keeps
      // bootstrap storms from hammering the DB too
      return { found: false, value: undefined, at: Date.now() };
    } finally {
      configInFlight.delete(key);
    }
  })();
  configInFlight.set(key, load);
  const entry = await load;
  configCache.set(key, entry);
  return entry;
}

type ConfigRow = { key: string; value: string };

export async function configGet<T = unknown>(key: string, fallback?: T): Promise<T> {
  const entry = await readConfigRow(key);
  if (entry.found) return entry.value as T;
  return fallback as T;
}

export async function configSet(key: string, value: unknown): Promise<void> {
  const data = JSON.stringify(value);
  await db.config.upsert({
    where: { key },
    update: { value: data },
    create: { key, value: data },
  });
  // Write-through: the new value is immediately visible to every reader on
  // THIS instance; other instances converge within the TTL.
  configCache.set(key, { found: true, value, at: Date.now() });
}

/** Python: Config.get(key) with env-aware default already resolved by the caller. */
export async function configGetOrSet<T>(key: string, fallback: T): Promise<T> {
  const entry = await readConfigRow(key);
  if (entry.found) return entry.value as T;
  await configSet(key, fallback);
  return fallback;
}

/** Drops every cached entry (admin settings saves use this to converge all
 * keys at once across… well, THIS instance — others follow within the TTL). */
export function invalidateConfigCache(): void {
  configCache.clear();
}
export function invalidateConfigKey(key: string): void {
  configCache.delete(key);
}

// ---------------------------------------------------------------------------
// Frequently used typed accessors
// ---------------------------------------------------------------------------

export async function cfgEnableSignup(): Promise<boolean> {
  return configGet<boolean>('ui.enable_signup', true);
}
export async function cfgDefaultUserRole(): Promise<string> {
  return configGet<string>('ui.default_user_role', 'pending');
}
export async function cfgJwtExpiry(): Promise<string> {
  return configGet<string>('auth.jwt_expiry', '-1');
}
