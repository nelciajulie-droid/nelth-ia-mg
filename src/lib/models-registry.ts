import type { ApiUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { env } from '@/lib/constants';
import { configGet } from '@/lib/config';
import { hasAccessGrant, hasAccessJson } from '@/lib/access-control';

/**
 * Merged model registry — port of main.py get_models():
 * merges connection models (OpenAI-compatible + Ollama) with workspace models
 * (the `model` table), applying per-user access control and group defaults.
 */

export type ModelItem = {
  id: string;
  name: string;
  object: string;
  created: number;
  owned_by: string;
  info?: Record<string, any> | null;
  arena?: boolean;
  access_control?: Record<string, any> | null;
  /** merged meta (front-end shape) */
  meta?: Record<string, any>;
  /** openai params preset */
  params?: Record<string, any>;
  presets?: Record<string, any>;
};

function safeJson(s: string | null): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Workspace models visible to the user (model table + access grants). */
export async function getWorkspaceModels(user: ApiUser): Promise<ModelItem[]> {
  const rows = await db.model.findMany();
  const out: ModelItem[] = [];
  for (const row of rows) {
    if (row.is_active === false) continue;
    // v0.12.5: model access control lives in the access_grant table.
    // PUBLIC-APP MODE: a workspace model without any access grant is public —
    // every member sees it (chatgpt-like shared model catalog). When grants
    // exist they decide, exactly like the Python access-control rules.
    const ac = await db.accessGrant.findMany({ where: { resource_type: 'model', resource_id: row.id } });
    const restricted = ac.length > 0;
    if (
      restricted &&
      user.role !== 'admin' &&
      !(await hasAccessGrant(user.id, 'model', row.id, 'read')) &&
      row.user_id !== user.id
    ) {
      continue;
    }
    const meta = safeJson(row.meta) ?? {};
    const params = safeJson(row.params) ?? {};
    const accessControl = ac.length
      ? {
          read: {
            group_ids: ac.filter((g) => g.principal_type === 'group' && g.permission === 'read').map((g) => g.principal_id),
            user_ids: ac.filter((g) => g.principal_type === 'user' && g.permission === 'read').map((g) => g.principal_id),
          },
          write: {
            group_ids: ac.filter((g) => g.principal_type === 'group' && g.permission === 'write').map((g) => g.principal_id),
            user_ids: ac.filter((g) => g.principal_type === 'user' && g.permission === 'write').map((g) => g.principal_id),
          },
        }
      : null;
    out.push({
      id: row.id,
      name: meta?.name ?? row.name ?? row.id,
      object: 'model',
      created: row.created_at ?? 0,
      owned_by: row.base_model_id ? 'openai' : 'workspace',
      info: {
        id: row.id,
        user_id: row.user_id,
        base_model_id: row.base_model_id ?? null,
        name: meta?.name ?? row.name ?? row.id,
        meta,
        params,
        access_control: accessControl,
        is_active: row.is_active,
        description: meta?.description ?? '',
      },
      meta,
      params,
      access_control: accessControl,
    });
  }
  return out;
}

/**
 * Full merged list — used by GET /api/models and /api/v1/models.
 * Connection models come from lib/connections (subagent-owned).
 */
export async function getModelsForUser(user: ApiUser): Promise<ModelItem[]> {
  const models: ModelItem[] = [];

  // OpenAI-compatible connections
  try {
    const { listConnectionModels } = await import('@/lib/connections');
    models.push(...(await listConnectionModels(user, 'openai')));
  } catch (e) {
    console.error('[models-registry] openai connections failed', e);
  }

  // Ollama connections
  try {
    const { listConnectionModels } = await import('@/lib/connections');
    models.push(...(await listConnectionModels(user, 'ollama')));
  } catch (e) {
    console.error('[models-registry] ollama connections failed', e);
  }

  // Workspace models (DB) — override/annotate connection entries by id
  const workspace = await getWorkspaceModels(user);
  for (const wm of workspace) {
    const idx = models.findIndex((m) => m.id === wm.id);
    if (idx >= 0) {
      const base = models[idx];
      models[idx] = {
        ...base,
        name: wm.name,
        info: { ...wm.info, ...(base.info ?? {}) },
        meta: wm.meta,
        params: wm.params,
        access_control: wm.access_control,
      };
    } else {
      models.push(wm);
    }
  }

  const defaultModels = await configGet<string>('ui.default_models', env.DEFAULT_MODELS);
  void defaultModels;

  // Built-in Kilo AI Gateway models (TS-port extension): exposed in the model
  // selector with zero external connections configured so chat completions
  // are testable out of the box.
  //   1. dots-studio/dots-3-note-preview:free  — standard chat model
  //   2. nvidia/nemotron-3-ultra-550b-a55b:free — reasoning (thinking) model
  const kiloLlmEnabled = await configGet<boolean>('kilo_llm.enable', true);
  if (kiloLlmEnabled) {
    const {
      KILO_MODEL_ID,
      KILO_MODEL_NAME,
      KILO_MODEL_DESCRIPTION,
      KILO_REASONING_MODEL_ID,
      KILO_REASONING_MODEL_NAME,
      KILO_REASONING_MODEL_DESCRIPTION,
      kiloAvailable,
    } = await import('@/lib/kilo-llm');
    if (kiloAvailable()) {
      const created = Math.floor(Date.now() / 1000);
      const defs: Array<[string, string, string, string[]]> = [
        [KILO_MODEL_ID, KILO_MODEL_NAME, KILO_MODEL_DESCRIPTION, ['llm', 'kilo', 'built-in']],
        [KILO_REASONING_MODEL_ID, KILO_REASONING_MODEL_NAME, KILO_REASONING_MODEL_DESCRIPTION, ['llm', 'kilo', 'raisonnement']],
      ];
      for (const [id, name, description, tags] of defs) {
        const meta = { id, name, description, tags: tags.map((t) => ({ name: t })) };
        models.push({
          id,
          name,
          object: 'model',
          created,
          owned_by: 'kilo_gateway',
          info: { id, name, meta, is_active: true, description },
          meta,
        });
      }
    }
  }

  // NOTE — image generation is deliberately NOT exposed here: it is a TOOL
  // (the image toggle in the chat input → features.image_generation), not a
  // chat model. The picker must list the two Kilo LLM models only. The
  // Nelthai engine stays reachable through that toggle (and through the
  // legacy `stable-diffusion-xl` ids saved in old chats — see v12-flow).

  return models;
}

/** Resolve the backend connection + base model for a model id (chat routing). */
export async function resolveModelRoute(
  modelId: string
): Promise<{ type: 'openai' | 'ollama'; baseUrl: string; apiKey: string; model: string } | null> {
  // Built-in Kilo gateway models route directly to the gateway (they are not
  // backed by a user-configured connection).
  const { isKiloModel, kiloAvailable, KILO_GATEWAY_BASE_URL, KILO_GATEWAY_API_KEY, normalizeKiloModelId } =
    await import('@/lib/kilo-llm');
  const normalized = normalizeKiloModelId(modelId);
  if (isKiloModel(normalized)) {
    if (!kiloAvailable()) return null;
    return { type: 'openai', baseUrl: KILO_GATEWAY_BASE_URL, apiKey: KILO_GATEWAY_API_KEY, model: normalized };
  }

  // workspace model overrides route to their base model
  const row = await db.model.findUnique({ where: { id: modelId } });
  const target = row?.base_model_id || modelId;

  const { resolveConnection } = await import('@/lib/connections');
  return resolveConnection(target);
}
