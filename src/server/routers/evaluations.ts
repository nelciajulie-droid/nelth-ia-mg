import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { configGet, configSet } from '@/lib/config';
import { env, ERROR_MESSAGES } from '@/lib/constants';
import { generateEmbeddings, cosineSimilarity } from '@/lib/retrieval/embeddings';
import { safeParse, nowSec, uuid, EM } from '@/lib/models/workspace';

/**
 * Port of open_webui/routers/evaluations.py (/api/v1/evaluations) +
 * models/feedbacks.py (Elo leaderboard: K=32, initial rating 1000).
 *
 * Deviation (documented): query-based leaderboard re-ranking uses the app
 * embedding function (lib/retrieval/embeddings) instead of the auxiliary
 * sentence-transformers model (USE_SLIM path in Python).
 */

const EVALUATION_CONFIG_KEYS: Record<string, string> = {
  ENABLE_EVALUATION_ARENA_MODELS: 'evaluation.arena.enable',
  EVALUATION_ARENA_MODELS: 'evaluation.arena.models',
};

const PAGE_ITEM_COUNT = 30;

function err(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

function requireUser(ctx: Ctx) {
  const user = ctx.user;
  if (!user) err(401, ERROR_MESSAGES.NOT_AUTHENTICATED);
  return user;
}

type FeedbackRow = {
  id: string;
  user_id: string | null;
  version: number | null;
  type: string | null;
  data: string | null;
  meta: string | null;
  snapshot: string | null;
  created_at: number | null;
  updated_at: number | null;
};

function rowToFeedbackModel(row: FeedbackRow) {
  return {
    id: row.id,
    user_id: row.user_id ?? '',
    version: row.version ?? 0,
    type: row.type ?? '',
    data: safeParse<Record<string, any> | null>(row.data, null),
    meta: safeParse<Record<string, any> | null>(row.meta, null),
    snapshot: safeParse<Record<string, any> | null>(row.snapshot, null),
    created_at: row.created_at ?? 0,
    updated_at: row.updated_at ?? 0,
  };
}

async function getConfigValues(keyMap: Record<string, string>): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  for (const [field, storageKey] of Object.entries(keyMap)) {
    const value = await db.config.findUnique({ where: { key: storageKey } });
    if (value) out[field] = safeParse<any>(value.value, value.value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Elo computation (models/feedbacks.py + routers/evaluations.py)
// ---------------------------------------------------------------------------

function calculateElo(
  feedbacks: Array<{ id: string; data: Record<string, any> | null }>,
  similarities: Record<string, number> | null
): Record<string, { rating: number; won: number; lost: number }> {
  const K_FACTOR = 32;
  const modelStats: Record<string, { rating: number; won: number; lost: number }> = {};

  const getOrCreate = (modelId: string) => {
    if (!modelStats[modelId]) modelStats[modelId] = { rating: 1000.0, won: 0, lost: 0 };
    return modelStats[modelId];
  };

  for (const feedback of feedbacks) {
    const data = feedback.data ?? {};
    const winnerId = data['model_id'];
    const ratingValue = String(data['rating'] ?? '');
    if (!winnerId || (ratingValue !== '1' && ratingValue !== '-1')) continue;

    const won = ratingValue === '1';
    const weight = similarities ? (similarities[feedback.id] ?? 1.0) : 1.0;

    for (const opponentId of data['sibling_model_ids'] ?? []) {
      const winner = getOrCreate(winnerId);
      const opponent = getOrCreate(opponentId);
      const expected = 1 / (1 + Math.pow(10, (opponent.rating - winner.rating) / 400));

      winner.rating += K_FACTOR * ((won ? 1 : 0) - expected) * weight;
      opponent.rating += K_FACTOR * ((won ? 0 : 1) - (1 - expected)) * weight;

      if (won) {
        winner.won += 1;
        opponent.lost += 1;
      } else {
        winner.lost += 1;
        opponent.won += 1;
      }
    }
  }
  return modelStats;
}

function getTopTags(
  feedbacks: Array<{ data: Record<string, any> | null }>,
  limit = 5
): Record<string, Array<{ tag: string; count: number }>> {
  const tagCounts: Record<string, Record<string, number>> = {};
  for (const feedback of feedbacks) {
    const data = feedback.data ?? {};
    const modelId = data['model_id'];
    if (!modelId) continue;
    tagCounts[modelId] ??= {};
    for (const tag of data['tags'] ?? []) {
      tagCounts[modelId][tag] = (tagCounts[modelId][tag] ?? 0) + 1;
    }
  }
  const out: Record<string, Array<{ tag: string; count: number }>> = {};
  for (const [modelId, tags] of Object.entries(tagCounts)) {
    out[modelId] = Object.entries(tags)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([tag, count]) => ({ tag, count }));
  }
  return out;
}

async function computeSimilarities(
  feedbacks: Array<{ id: string; data: Record<string, any> | null }>,
  query: string
): Promise<Record<string, number>> {
  const tagSet = new Set<string>();
  for (const feedback of feedbacks) {
    for (const tag of feedback.data?.['tags'] ?? []) tagSet.add(tag);
  }
  const tags = [...tagSet];
  if (!tags.length) return {};

  try {
    const embeddings = await generateEmbeddings(env.RAG_EMBEDDING_MODEL, [query, ...tags]);
    const queryEmbedding = embeddings[0];
    const tagScores: Record<string, number> = {};
    tags.forEach((tag, idx) => {
      tagScores[tag] = cosineSimilarity(queryEmbedding, embeddings[idx + 1]);
    });
    const similarities: Record<string, number> = {};
    for (const feedback of feedbacks) {
      const scores = (feedback.data?.['tags'] ?? []).map((tag: string) => tagScores[tag] ?? 0);
      similarities[feedback.id] = scores.length ? Math.max(...scores) : 0;
    }
    return similarities;
  } catch (e) {
    console.error(`Embedding error: ${e}`);
    return {};
  }
}

function dateStr(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function getModelEvaluationHistory(modelId: string, days: number): Promise<any[]> {
  const cutoff = days === 0 ? null : nowSec() - days * 86400;
  const rows = await db.feedback.findMany(cutoff !== null ? { where: { created_at: { gte: cutoff } } } : undefined);

  const dailyCounts: Record<string, { won: number; lost: number }> = {};
  let firstDate: string | null = null;
  for (const row of rows) {
    const data = safeParse<Record<string, any> | null>(row.data, null);
    if (!data) continue;
    if (data['model_id'] !== modelId) continue;
    const ratingStr = String(data['rating'] ?? '');
    if (ratingStr !== '1' && ratingStr !== '-1') continue;
    const ds = dateStr(row.created_at ?? 0);
    dailyCounts[ds] ??= { won: 0, lost: 0 };
    if (ratingStr === '1') dailyCounts[ds].won += 1;
    else dailyCounts[ds].lost += 1;
    if (firstDate === null || ds < firstDate) firstDate = ds;
  }

  const today = new Date();
  const todayStr = dateStr(Math.floor(today.getTime() / 1000));
  let numDays = days;
  let startDate: Date;
  if (days === 0 && firstDate) {
    startDate = new Date(`${firstDate}T00:00:00`);
    numDays = Math.floor((today.getTime() - startDate.getTime()) / 86400000) + 1;
  } else {
    startDate = new Date(today.getTime() - (days - 1) * 86400000);
  }

  const result: any[] = [];
  for (let i = 0; i < numDays; i++) {
    const d = new Date(startDate.getTime() + i * 86400000);
    const ds = dateStr(Math.floor(d.getTime() / 1000));
    const counts = dailyCounts[ds] ?? { won: 0, lost: 0 };
    result.push({ date: ds, won: counts.won, lost: counts.lost });
  }
  void todayStr;
  return result;
}

// ---------------------------------------------------------------------------
// Feedback list assembly
// ---------------------------------------------------------------------------

async function feedbackListResponse(
  rows: FeedbackRow[],
  total: number
): Promise<{ items: any[]; total: number }> {
  const userIds = [...new Set(rows.map((r) => r.user_id ?? '').filter(Boolean))];
  const users = await db.user.findMany({ where: { id: { in: userIds } } });
  const usersById = new Map(users.map((u) => [u.id, u]));
  return {
    items: rows.map((row) => {
      const model = rowToFeedbackModel(row);
      const user = usersById.get(row.user_id ?? '');
      return {
        ...model,
        user: user
          ? { id: user.id, name: user.name, role: user.role ?? 'pending', email: user.email ?? '' }
          : null,
      };
    }),
    total,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // GET /leaderboard (admin)
  {
    method: 'GET',
    path: 'leaderboard',
    auth: 'admin',
    handler: async (ctx) => {
      const query = ctx.query.get('query');
      const rows = await db.feedback.findMany({ select: { id: true, data: true } });
      const feedbacks = rows.map((row) => ({
        id: row.id,
        data: safeParse<Record<string, any> | null>(row.data, null),
      }));

      let similarities: Record<string, number> | null = null;
      if (query && query.trim()) {
        similarities = await computeSimilarities(feedbacks, query.trim());
      }

      const eloStats = calculateElo(feedbacks, similarities);
      const tagsByModel = getTopTags(feedbacks);

      const entries = Object.entries(eloStats)
        .map(([modelId, s]) => ({
          model_id: modelId,
          rating: Math.round(s.rating),
          won: s.won,
          lost: s.lost,
          count: s.won + s.lost,
          top_tags: tagsByModel[modelId] ?? [],
        }))
        .sort((a, b) => b.rating - a.rating);

      return ctx.json({ entries });
    },
  },

  // GET /leaderboard/:model_id/history (admin)
  {
    method: 'GET',
    path: 'leaderboard/:model_id/history',
    auth: 'admin',
    handler: async (ctx) => {
      const modelId = ctx.params.model_id;
      const days = Number(ctx.query.get('days') ?? 30) || 30;
      return ctx.json({ model_id: modelId, history: await getModelEvaluationHistory(modelId, days) });
    },
  },

  // GET /config (admin)
  {
    method: 'GET',
    path: 'config',
    auth: 'admin',
    handler: async (ctx) => {
      void ctx;
      return ctx.json(await getConfigValues(EVALUATION_CONFIG_KEYS));
    },
  },

  // POST /config (admin)
  {
    method: 'POST',
    path: 'config',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<{
        ENABLE_EVALUATION_ARENA_MODELS?: boolean | null;
        EVALUATION_ARENA_MODELS?: any[] | null;
      }>();
      if (form.ENABLE_EVALUATION_ARENA_MODELS !== null && form.ENABLE_EVALUATION_ARENA_MODELS !== undefined) {
        await configSet('evaluation.arena.enable', form.ENABLE_EVALUATION_ARENA_MODELS);
      }
      if (form.EVALUATION_ARENA_MODELS !== null && form.EVALUATION_ARENA_MODELS !== undefined) {
        await configSet('evaluation.arena.models', form.EVALUATION_ARENA_MODELS);
      }
      return ctx.json(await getConfigValues(EVALUATION_CONFIG_KEYS));
    },
  },

  // GET /feedbacks/models (admin)
  {
    method: 'GET',
    path: 'feedbacks/models',
    auth: 'admin',
    handler: async (ctx) => {
      void ctx;
      const rows = await db.feedback.findMany({ select: { data: true } });
      const modelIds = new Set<string>();
      for (const row of rows) {
        const data = safeParse<Record<string, any> | null>(row.data, null);
        if (data && data['model_id']) modelIds.add(String(data['model_id']));
      }
      return ctx.json([...modelIds].sort());
    },
  },

  // GET /feedbacks/all/ids (admin)
  {
    method: 'GET',
    path: 'feedbacks/all/ids',
    auth: 'admin',
    handler: async (ctx) => {
      void ctx;
      const rows = await db.feedback.findMany({
        orderBy: { updated_at: 'desc' },
        select: { id: true, user_id: true, created_at: true, updated_at: true },
      });
      return ctx.json(
        rows.map((row) => ({
          id: row.id,
          user_id: row.user_id ?? '',
          created_at: row.created_at ?? 0,
          updated_at: row.updated_at ?? 0,
        }))
      );
    },
  },

  // DELETE /feedbacks/all (admin)
  {
    method: 'DELETE',
    path: 'feedbacks/all',
    auth: 'admin',
    handler: async (ctx) => {
      const result = await db.feedback.deleteMany({});
      return ctx.json(result.count > 0);
    },
  },

  // GET /feedbacks/all/export (admin)
  {
    method: 'GET',
    path: 'feedbacks/all/export',
    auth: 'admin',
    handler: async (ctx) => {
      const modelId = ctx.query.get('model_id');
      const rows = await db.feedback.findMany({ orderBy: { updated_at: 'desc' } });
      let feedbacks = rows.map(rowToFeedbackModel);
      if (modelId) {
        feedbacks = feedbacks.filter((f) => f.data && f.data['model_id'] === modelId);
      }
      return ctx.json(feedbacks);
    },
  },

  // GET /feedbacks/user (verified user)
  {
    method: 'GET',
    path: 'feedbacks/user',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const page = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
      const skip = (page - 1) * PAGE_ITEM_COUNT;
      const rows = await db.feedback.findMany({
        where: { user_id: user.id },
        orderBy: { updated_at: 'desc' },
      });
      const total = rows.length;
      const pageRows = rows.slice(skip, skip + PAGE_ITEM_COUNT);
      return ctx.json(await feedbackListResponse(pageRows, total));
    },
  },

  // DELETE /feedbacks (verified user) — delete own feedbacks
  {
    method: 'DELETE',
    path: 'feedbacks',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const result = await db.feedback.deleteMany({ where: { user_id: user.id } });
      return ctx.json(result.count > 0);
    },
  },

  // GET /feedbacks/list (admin)
  {
    method: 'GET',
    path: 'feedbacks/list',
    auth: 'admin',
    handler: async (ctx) => {
      const orderBy = ctx.query.get('order_by');
      const direction = ctx.query.get('direction');
      const page = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
      const modelId = ctx.query.get('model_id');
      const skip = (page - 1) * PAGE_ITEM_COUNT;

      const rows = await db.feedback.findMany();
      const users = await db.user.findMany({ where: { id: { in: rows.map((r) => r.user_id ?? '') } } });
      const usersById = new Map(users.map((u) => [u.id, u]));

      let filtered = rows.map((row) => ({ row, model: rowToFeedbackModel(row) }));
      if (modelId) {
        filtered = filtered.filter((f) => f.model.data?.['model_id'] === modelId);
      }

      const dir = direction === 'asc' ? 1 : -1;
      if (orderBy === 'username') {
        filtered.sort((a, b) => {
          const an = usersById.get(a.row.user_id ?? '')?.name ?? '';
          const bn = usersById.get(b.row.user_id ?? '')?.name ?? '';
          return an.localeCompare(bn) * dir;
        });
      } else if (orderBy === 'model_id' || orderBy === 'rating') {
        filtered.sort((a, b) => {
          const av = String(a.model.data?.[orderBy] ?? '');
          const bv = String(b.model.data?.[orderBy] ?? '');
          return av.localeCompare(bv) * dir;
        });
      } else if (orderBy === 'updated_at') {
        filtered.sort((a, b) => ((a.row.updated_at ?? 0) - (b.row.updated_at ?? 0)) * dir);
      } else {
        filtered.sort((a, b) => (b.row.created_at ?? 0) - (a.row.created_at ?? 0));
      }

      const total = filtered.length;
      const pageRows = filtered.slice(skip, skip + PAGE_ITEM_COUNT).map((f) => f.row);
      return ctx.json(await feedbackListResponse(pageRows, total));
    },
  },

  // POST /feedback (verified user) — create
  {
    method: 'POST',
    path: 'feedback',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const form = await ctx.body<{
        type?: string;
        data?: Record<string, any> | null;
        meta?: Record<string, any> | null;
        snapshot?: Record<string, any> | null;
      }>();
      const now = nowSec();
      try {
        const row = await db.feedback.create({
          data: {
            id: uuid(),
            user_id: user.id,
            version: 0,
            type: String(form.type ?? ''),
            data: form.data ? JSON.stringify(form.data) : null,
            meta: form.meta ? JSON.stringify(form.meta) : null,
            snapshot: form.snapshot ? JSON.stringify(form.snapshot) : null,
            created_at: now,
            updated_at: now,
          },
        });
        return ctx.json(rowToFeedbackModel(row));
      } catch (e) {
        console.error(`Error creating a new feedback: ${e}`);
        err(400, EM.DEFAULT());
      }
    },
  },

  // GET /feedback/:id (verified user) — 2-segment routes after static feedbacks/*
  {
    method: 'GET',
    path: 'feedback/:id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const row =
        user.role === 'admin'
          ? await db.feedback.findUnique({ where: { id } })
          : await db.feedback.findFirst({ where: { id, user_id: user.id } });
      if (!row) err(404, ERROR_MESSAGES.NOT_FOUND);
      return ctx.json(rowToFeedbackModel(row));
    },
  },

  // POST /feedback/:id (verified user) — update
  {
    method: 'POST',
    path: 'feedback/:id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const form = await ctx.body<{
        type?: string;
        data?: Record<string, any> | null;
        meta?: Record<string, any> | null;
        snapshot?: Record<string, any> | null;
      }>();
      const existing =
        user.role === 'admin'
          ? await db.feedback.findUnique({ where: { id } })
          : await db.feedback.findFirst({ where: { id, user_id: user.id } });
      if (!existing) err(404, ERROR_MESSAGES.NOT_FOUND);

      await db.feedback.update({
        where: { id },
        data: {
          ...(form.data ? { data: JSON.stringify(form.data) } : {}),
          ...(form.meta ? { meta: JSON.stringify(form.meta) } : {}),
          ...(form.snapshot ? { snapshot: JSON.stringify(form.snapshot) } : {}),
          updated_at: nowSec(),
        },
      });
      const updated = await db.feedback.findUnique({ where: { id } });
      return ctx.json(rowToFeedbackModel(updated as FeedbackRow));
    },
  },

  // DELETE /feedback/:id (verified user)
  {
    method: 'DELETE',
    path: 'feedback/:id',
    auth: 'user',
    handler: async (ctx) => {
      const user = requireUser(ctx);
      const id = ctx.params.id;
      const existing =
        user.role === 'admin'
          ? await db.feedback.findUnique({ where: { id } })
          : await db.feedback.findFirst({ where: { id, user_id: user.id } });
      if (!existing) err(404, ERROR_MESSAGES.NOT_FOUND);
      await db.feedback.delete({ where: { id } });
      return ctx.json(true);
    },
  },
];
