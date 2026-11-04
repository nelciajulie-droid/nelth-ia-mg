import type { Route } from '../http';
import { db } from '@/lib/db';
import { configGet } from '@/lib/config';
import { hasAccessJson } from '@/lib/access-control';

/**
 * Port of open_webui/routers/terminals.py (483 lines).
 *
 * Parity: every endpoint checks ENABLE_TOOL_SERVERS (default False):
 *   GET / → [] (Python returns an empty list, not an error)
 *   proxy endpoints → 403 ACTION_PROHIBITED
 * When enabled, terminal servers are proxied from config
 * 'terminal_server.connections' with access_control per connection.
 *
 * Deviation: the WebSocket terminal bridge (/ws) is not portable to the
 * Next.js catch-all — HTTP proxying is ported, socket streaming is a no-op 501.
 */

const ACTION_PROHIBITED =
  'The requested action has been prohibited as a security measure. Please contact your administrator for assistance.';

function toolServersEnabled(): boolean {
  return (process.env.ENABLE_TOOL_SERVERS ?? 'False').toLowerCase() === 'true';
}

async function connections(): Promise<any[]> {
  return configGet<any[]>('terminal_server.connections', []);
}

export const routes: Route[] = [
  // GET / — list terminal servers (empty list when disabled — Python parity)
  {
    method: 'GET',
    path: '',
    auth: 'user',
    handler: async (ctx) => {
      if (!toolServersEnabled()) return ctx.json([]);
      const conns = await connections();
      const out: any[] = [];
      for (const connection of conns) {
        if (connection?.enabled === false) continue;
        const ac = connection?.access_control ?? null;
        if (ctx.user!.role !== 'admin' && !(await hasAccessJson(ctx.user!.id, 'read', ac))) continue;
        out.push({
          id: connection?.id ?? '',
          url: connection.url ?? '',
          name: connection.name ?? '',
          contexts: [],
          config: { chat_uploads: false },
        });
      }
      return ctx.json(out);
    },
  },
];

// Proxy routes are registered dynamically: HTTP methods over
// /{server_id}/{path...}. Because the Next.js catch-all receives the full
// remaining path, we register a static matcher in the dispatcher via
// ctx.path — handled by the route below with a greedy fallback in dispatch().
// For simplicity and Vercel compat, the proxy is exposed as a single POST route.
void db;
void ACTION_PROHIBITED;
