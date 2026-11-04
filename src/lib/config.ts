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

type ConfigRow = { key: string; value: string };

export async function configGet<T = unknown>(key: string, fallback?: T): Promise<T> {
  let value: T | undefined;
  try {
    const row = (await db.config.findUnique({ where: { key } })) as ConfigRow | null;
    if (row) {
      try {
        value = JSON.parse(row.value) as T;
      } catch {
        value = (row.value as unknown) as T;
      }
    }
  } catch {
    // table might not exist yet during bootstrap
  }
  return value !== undefined ? value : (fallback as T);
}

export async function configSet(key: string, value: unknown): Promise<void> {
  const data = JSON.stringify(value);
  await db.config.upsert({
    where: { key },
    update: { value: data },
    create: { key, value: data },
  });
}

/** Python: Config.get(key) with env-aware default already resolved by the caller. */
export async function configGetOrSet<T>(key: string, fallback: T): Promise<T> {
  const existing = await configGet<T | undefined>(key, undefined);
  if (existing !== undefined) return existing;
  await configSet(key, fallback);
  return fallback;
}

/** No-op kept for API compatibility (config reads are uncached). */
export function invalidateConfigCache(): void {}
export function invalidateConfigKey(_key: string): void {}

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
