import type { Route } from '../http';
import { HttpError, queryIntStrict } from '../http';
import { db } from '@/lib/db';
import { configGet } from '@/lib/config';

/**
 * Port of open_webui/routers/analytics.py (582 lines) — admin analytics over
 * chat_message usage. All endpoints require admin auth (get_admin_user).
 * ChatMessage timestamps are nanoseconds (time_ns).
 */

const nsPerDay = 86_400_000_000_000n;
function dayStartNs(ts: number): number {
  const ns = BigInt(ts);
  return Number(ns - (ns % nsPerDay));
}
function nsToSec(ts: number): number {
  return Math.floor(Number(ts) / 1e9);
}
void dayStartNs;
void nsToSec;

function parseRange(query: URLSearchParams): { start: number | null; end: number | null } {
  // Python: Optional[int] Query params — FastAPI 422s non-integer values.
  const start = queryIntStrict(query, 'start_date');
  const end = queryIntStrict(query, 'end_date');
  if (start !== null && end !== null && start > end) {
    // Python: 400 Start date must be before end date
    throw new HttpError(400, 'Start date must be before end date');
  }
  // Python compares epoch seconds directly against chat_message.created_at
  // (which stores seconds) — no unit conversion.
  return { start, end };
}

function rangeErr(): never {
  throw new HttpError(400, 'Start date must be before end date');
}

export const routes: Route[] = [
  // GET /models — message counts per model
  {
    method: 'GET',
    path: 'models',
    auth: 'admin',
    handler: async (ctx) => {
      const { start, end } = parseRange(ctx.query);
      if (start !== null && end !== null && start > end) rangeErr();
      const messages = await db.chatMessage.findMany({
        where: {
          role: 'assistant',
          ...(start !== null || end !== null
            ? {
                created_at: {
                  ...(start !== null ? { gte: start } : {}),
                  ...(end !== null ? { lte: end } : {}),
                },
              }
            : {}),
        },
        select: { model_id: true, created_at: true },
      });
      const counts: Record<string, { model_id: string; count: number; total_tokens: number }> = {};
      for (const m of messages) {
        const id = m.model_id ?? 'unknown';
        counts[id] ??= { model_id: id, count: 0, total_tokens: 0 };
        counts[id].count += 1;
      }
      const models = Object.values(counts).sort((a, b) => b.count - a.count);
      return ctx.json({ models });
    },
  },

  // GET /users — message counts per user
  {
    method: 'GET',
    path: 'users',
    auth: 'admin',
    handler: async (ctx) => {
      const { start, end } = parseRange(ctx.query);
      if (start !== null && end !== null && start > end) rangeErr();
      const messages = await db.chatMessage.findMany({
        where: {
          ...(start !== null || end !== null
            ? {
                created_at: {
                  ...(start !== null ? { gte: start } : {}),
                  ...(end !== null ? { lte: end } : {}),
                },
              }
            : {}),
        },
        select: { user_id: true, model_id: true, created_at: true },
      });
      const byUser: Record<string, { user_id: string; name: string; chat_count: number; message_count: number; total_tokens: number }> = {};
      const chatIdsByUser: Record<string, Set<string>> = {};
      for (const m of messages) {
        const uid = m.user_id ?? 'unknown';
        byUser[uid] ??= { user_id: uid, name: '', chat_count: 0, message_count: 0, total_tokens: 0 };
        byUser[uid].message_count += 1;
        (chatIdsByUser[uid] ??= new Set());
      }
      // chat counts
      const chats = await db.chat.findMany({ select: { id: true, user_id: true } });
      for (const c of chats) {
        const uid = c.user_id ?? 'unknown';
        if (byUser[uid]) byUser[uid].chat_count += 1;
      }
      const users = await db.user.findMany({ select: { id: true, name: true } });
      const nameById = new Map(users.map((u) => [u.id, u.name]));
      for (const uid of Object.keys(byUser)) byUser[uid].name = nameById.get(uid) ?? '';
      void chatIdsByUser;
      return ctx.json({ users: Object.values(byUser) });
    },
  },

  // GET /messages — recent messages across all chats
  {
    method: 'GET',
    path: 'messages',
    auth: 'admin',
    handler: async (ctx) => {
      const { start, end } = parseRange(ctx.query);
      if (start !== null && end !== null && start > end) rangeErr();
      const messages = await db.chatMessage.findMany({
        where: {
          ...(start !== null || end !== null
            ? {
                created_at: {
                  ...(start !== null ? { gte: start } : {}),
                  ...(end !== null ? { lte: end } : {}),
                },
              }
            : {}),
        },
        orderBy: { created_at: 'desc' },
        take: 100,
      });
      return ctx.json(
        messages.map((m) => ({
          id: m.id,
          chat_id: m.chat_id,
          user_id: m.user_id,
          role: m.role,
          content: m.content,
          model_id: m.model_id,
          created_at: m.created_at,
        }))
      );
    },
  },

  // GET /summary
  {
    method: 'GET',
    path: 'summary',
    auth: 'admin',
    handler: async (ctx) => {
      const { start, end } = parseRange(ctx.query);
      if (start !== null && end !== null && start > end) rangeErr();
      const where = {
        ...(start !== null || end !== null
          ? {
              created_at: {
                ...(start !== null ? { gte: start } : {}),
                ...(end !== null ? { lte: end } : {}),
              },
            }
          : {}),
      };
      const [totalChats, totalMessages, totalUsers] = await Promise.all([
        db.chat.count(),
        db.chatMessage.count({ where }),
        db.user.count(),
      ]);
      return ctx.json({
        total_chats: totalChats,
        total_messages: totalMessages,
        total_users: totalUsers,
        total_tokens: 0,
      });
    },
  },

  // GET /daily
  {
    method: 'GET',
    path: 'daily',
    auth: 'admin',
    handler: async (ctx) => {
      const { start, end } = parseRange(ctx.query);
      if (start !== null && end !== null && start > end) rangeErr();
      const messages = await db.chatMessage.findMany({
        where: {
          ...(start !== null || end !== null
            ? {
                created_at: {
                  ...(start !== null ? { gte: start } : {}),
                  ...(end !== null ? { lte: end } : {}),
                },
              }
            : {}),
        },
        select: { created_at: true, role: true, chat_id: true },
      });
      const daily: Record<string, { date: string; chat_count: number; message_count: number; total_tokens: number }> = {};
      const chatsPerDay = new Map<string, Set<string>>();
      for (const m of messages) {
        // Python: strftime('%Y-%m-%d', timestamp, 'unixepoch', 'localtime')
        const d = new Date((m.created_at ?? 0) * 1000);
        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        daily[date] ??= { date, chat_count: 0, message_count: 0, total_tokens: 0 };
        daily[date].message_count += 1;
        (chatsPerDay.get(date) ?? new Set<string>()).add(m.chat_id);
        chatsPerDay.set(date, chatsPerDay.get(date) ?? new Set<string>());
      }
      for (const [date, ids] of chatsPerDay) daily[date].chat_count = ids.size;
      return ctx.json({ daily: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date)) });
    },
  },

  // GET /tokens
  {
    method: 'GET',
    path: 'tokens',
    auth: 'admin',
    handler: async (ctx) => {
      // Token usage is stored per message in usage JSON when available.
      const { start, end } = parseRange(ctx.query);
      if (start !== null && end !== null && start > end) rangeErr();
      const messages = await db.chatMessage.findMany({
        where: {
          role: 'assistant',
          ...(start !== null || end !== null
            ? {
                created_at: {
                  ...(start !== null ? { gte: start } : {}),
                  ...(end !== null ? { lte: end } : {}),
                },
              }
            : {}),
        },
        select: { usage: true, model_id: true },
      });
      const perModel: Record<string, { model_id: string; prompt_tokens: number; completion_tokens: number; total_tokens: number }> = {};
      for (const m of messages) {
        const id = m.model_id ?? 'unknown';
        let usage: any = null;
        try {
          usage = m.usage ? JSON.parse(m.usage) : null;
        } catch {
          usage = null;
        }
        perModel[id] ??= { model_id: id, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        perModel[id].prompt_tokens += usage?.prompt_tokens ?? 0;
        perModel[id].completion_tokens += usage?.completion_tokens ?? 0;
        perModel[id].total_tokens += usage?.total_tokens ?? 0;
      }
      return ctx.json({ models: Object.values(perModel) });
    },
  },

  // GET /sessions — chat sessions listing (analytics_sessions read-only view)
  {
    method: 'GET',
    path: 'sessions',
    auth: 'admin',
    handler: async (ctx) => {
      const page = Math.max(1, Number(ctx.query.get('page') ?? 1));
      const limit = Math.min(100, Number(ctx.query.get('limit') ?? 20));
      const chats = await db.chat.findMany({
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: { id: true, user_id: true, title: true, created_at: true, updated_at: true },
      });
      return ctx.json({
        items: chats.map((c) => ({
          chat_id: c.id,
          user_id: c.user_id,
          title: c.title,
          started_at: c.created_at,
          last_activity_at: c.updated_at,
        })),
        total: await db.chat.count(),
        page,
      });
    },
  },

  // GET /sessions/:chat_id
  {
    method: 'GET',
    path: 'sessions/:chat_id',
    auth: 'admin',
    handler: async (ctx) => {
      const chat = await db.chat.findFirst({ where: { id: ctx.params.chat_id } });
      if (!chat) return ctx.error(404, 'We could not find what you were looking for.');
      return ctx.json({
        chat_id: chat.id,
        user_id: chat.user_id,
        title: chat.title,
        started_at: chat.created_at,
        last_activity_at: chat.updated_at,
      });
    },
  },
];

void db;
void configGet;
void nsToSec;
