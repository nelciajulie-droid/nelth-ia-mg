import type { ApiUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { env } from '@/lib/constants';
import type { ModelItem } from '@/lib/models-registry';

/**
 * Connections layer — port of open_webui utils/models.py + routers/openai.py +
 * routers/ollama.py connection handling.
 *
 * Connection sources (in resolution order):
 *   1. `connection` rows in the config table (`openai.api.configs` / `ollama.api.configs`)
 *      — multi-connection support with per-connection keys
 *   2. env defaults OPENAI_API_BASE_URL/KEY, OLLAMA_API_BASE_URL
 */

export type OpenAiConnection = {
  key: string;
  base_url: string;
  api_key: string;
  prefix: string | null;
};

export type OllamaConnection = {
  key: string;
  url: string;
  prefix: string | null;
};

async function readConfig<T>(key: string, fallback: T): Promise<T> {
  const row = await db.config.findUnique({ where: { key } });
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export async function getOpenAiConnections(user?: ApiUser | null): Promise<OpenAiConnection[]> {
  if (!env.ENABLE_OPENAI_API) return [];
  const configs = await readConfig<Record<string, any> | null>('openai.api.configs', null);
  const conns: OpenAiConnection[] = [];
  if (configs && typeof configs === 'object') {
    for (const [key, cfg] of Object.entries(configs)) {
      if (!cfg?.base_url) continue;
      conns.push({
        key,
        base_url: String(cfg.base_url).replace(/\/$/, ''),
        api_key: String(cfg.api_key ?? ''),
        prefix: cfg.prefix_id ?? null,
      });
    }
  }
  if (env.OPENAI_API_KEY) {
    conns.push({
      key: 'default',
      base_url: env.OPENAI_API_BASE_URL.replace(/\/$/, ''),
      api_key: env.OPENAI_API_KEY,
      prefix: null,
    });
  }
  return conns;
}

export async function getOllamaConnections(user?: ApiUser | null): Promise<OllamaConnection[]> {
  if (!env.ENABLE_OLLAMA_API) return [];
  const configs = await readConfig<Record<string, any> | null>('ollama.api.configs', null);
  const conns: OllamaConnection[] = [];
  if (configs && typeof configs === 'object') {
    for (const [key, cfg] of Object.entries(configs)) {
      if (!cfg?.url) continue;
      conns.push({ key, url: String(cfg.url).replace(/\/$/, ''), prefix: cfg.prefix_id ?? null });
    }
  }
  conns.push({ key: 'default', url: env.OLLAMA_API_BASE_URL.replace(/\/$/, ''), prefix: null });
  return conns;
}

/** List models for a mount type — used by /api/models merge. */
export async function listConnectionModels(user: ApiUser, kind: 'openai' | 'ollama'): Promise<ModelItem[]> {
  const models: ModelItem[] = [];
  const now = Math.floor(Date.now() / 1000);
  if (kind === 'openai') {
    for (const conn of await getOpenAiConnections(user)) {
      try {
        const res = await fetch(`${conn.base_url}/models`, {
          headers: conn.api_key ? { Authorization: `Bearer ${conn.api_key}` } : {},
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) continue;
        const data = await res.json();
        for (const m of data?.data ?? []) {
          const id = m.id as string;
          if (id.startsWith('bge-') || id.endsWith('embed')) continue;
          models.push({
            id,
            name: id,
            object: 'model',
            created: m.created ?? now,
            owned_by: m.owned_by ?? 'openai',
            info: undefined,
          });
        }
      } catch {
        // connection down → skip
      }
    }
  } else {
    for (const conn of await getOllamaConnections(user)) {
      try {
        const res = await fetch(`${conn.url}/api/tags`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) continue;
        const data = await res.json();
        for (const m of data?.models ?? []) {
          const id = m.name as string;
          if ((m?.details?.family ?? '').includes('bert')) continue;
          models.push({
            id,
            name: id,
            object: 'model',
            created: m.created_at ?? now,
            owned_by: 'ollama',
            info: undefined,
          });
        }
      } catch {
        // connection down → skip
      }
    }
  }
  return models;
}

/** Resolve which connection serves a given model id. */
export async function resolveConnection(
  modelId: string
): Promise<{ type: 'openai' | 'ollama'; baseUrl: string; apiKey: string; model: string } | null> {
  // 1. openai connections: model ids may carry a prefix ("prefix/model")
  for (const conn of await getOpenAiConnections()) {
    if (conn.prefix && modelId.startsWith(`${conn.prefix}/`)) {
      return { type: 'openai', baseUrl: conn.base_url, apiKey: conn.api_key, model: modelId.slice(conn.prefix.length + 1) };
    }
  }
  // 2. exact-model match against live openai models is deferred to request time (proxy fallback)
  // 3. ollama connections
  for (const conn of await getOllamaConnections()) {
    if (conn.prefix && modelId.startsWith(`${conn.prefix}/`)) {
      return { type: 'ollama', baseUrl: conn.url, apiKey: '', model: modelId.slice(conn.prefix.length + 1) };
    }
  }
  // 4. default routing: openai key set → openai, else ollama
  if (env.OPENAI_API_KEY) {
    for (const conn of await getOpenAiConnections()) {
      if (conn.key === 'default') {
        return { type: 'openai', baseUrl: conn.base_url, apiKey: conn.api_key, model: modelId };
      }
    }
  }
  const ollama = await getOllamaConnections();
  if (ollama.length) {
    const c = ollama.find((o) => o.key === 'default') ?? ollama[0];
    return { type: 'ollama', baseUrl: c.url, apiKey: '', model: modelId };
  }
  return null;
}
