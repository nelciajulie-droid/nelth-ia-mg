export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest } from 'next/server';
import { buildCtx } from '@/server/http';
import {
  getTaskIdsByChatId,
  getTaskIdsByUser,
  stopTask,
  stopTasksByChatId,
} from '@/lib/task-manager';

/**
 * /api/tasks/* — port of the Open WebUI main.py task routes (v0.12.5).
 *
 *   GET  /api/tasks                      → { task_ids: [...] }  (all user tasks)
 *   GET  /api/tasks/chat/{chat_id}       → { task_ids: [...] }  (polled by the
 *                                           frontend on socket reconnect and
 *                                           chat load)
 *   POST /api/tasks/chat/{chat_id}/stop  → { status: true }     (stop button)
 *   POST /api/tasks/stop/{task_id}       → { status: true }
 *
 * Every response is JSON — the ORIGINAL frontend API layer runs
 * `throw await res.json()` on non-OK responses, so a FastAPI-style JSON 404
 * (not an HTML error page) is mandatory here.
 */

type Params = { params: Promise<{ path?: string[] }> };

async function handler(req: NextRequest, { params }: Params): Promise<Response> {
  const { path } = await params;
  const segments = path ?? [];

  // Auth (same rule as every other authenticated route).
  const ctx = await buildCtx(req as unknown as Request, segments.join('/'), {});
  if (!ctx.user) {
    return Response.json({ detail: 'Not authenticated' }, { status: 401 });
  }
  const user = ctx.user;

  const notFound = () => Response.json({ detail: 'Not Found' }, { status: 404 });
  const methodNotAllowed = () => Response.json({ detail: 'Method Not Allowed' }, { status: 405 });

  // GET /api/tasks
  if (segments.length === 0) {
    if (req.method !== 'GET') return methodNotAllowed();
    return Response.json({ task_ids: getTaskIdsByUser(user.id) });
  }

  // GET /api/tasks/chat/{chat_id}
  if (segments.length === 2 && segments[0] === 'chat') {
    if (req.method !== 'GET') return methodNotAllowed();
    return Response.json({ task_ids: getTaskIdsByChatId(user.id, segments[1]) });
  }

  // POST /api/tasks/chat/{chat_id}/stop
  if (segments.length === 3 && segments[0] === 'chat' && segments[2] === 'stop') {
    if (req.method !== 'POST') return methodNotAllowed();
    const stopped = stopTasksByChatId(user.id, segments[1]);
    return Response.json({ status: true, stopped });
  }

  // POST /api/tasks/stop/{task_id}
  if (segments.length === 2 && segments[0] === 'stop') {
    if (req.method !== 'POST') return methodNotAllowed();
    const stopped = stopTask(user.id, segments[1]);
    return Response.json({ status: true, stopped });
  }

  return notFound();
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
