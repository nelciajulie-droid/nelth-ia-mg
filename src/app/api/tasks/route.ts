export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest } from 'next/server';
import { buildCtx } from '@/server/http';
import { getTaskIdsByUser } from '@/lib/task-manager';

/** GET /api/tasks → { task_ids: [...] } (bare path; chat-scoped routes live
 *  under /api/tasks/[...path]). JSON only — the frontend parses every
 *  response body as JSON. */
export async function GET(req: NextRequest): Promise<Response> {
  const ctx = await buildCtx(req as unknown as Request, 'tasks', {});
  if (!ctx.user) {
    return Response.json({ detail: 'Not authenticated' }, { status: 401 });
  }
  return Response.json({ task_ids: getTaskIdsByUser(ctx.user.id) });
}
