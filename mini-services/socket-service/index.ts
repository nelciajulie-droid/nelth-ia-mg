/**
 * Socket.IO service — port of open_webui/socket/main.py (Open WebUI v0.12.5).
 *
 * The ORIGINAL frontend connects to `/ws/socket.io` (same origin, untouched).
 * The Next.js backend emits events to user rooms via the internal POST /emit
 * endpoint (Python: sio.emit('events', {...}, room=f'user:{user_id}')).
 *
 * Topology: the web app proxies same-origin /ws/* requests to this service
 * (src/app/ws/[...path]/route.ts), so the whole product is reachable from a
 * single origin/port — it runs identically behind a reverse proxy, on a
 * container platform, or directly on a host.
 *
 * Configuration (all optional — sane defaults):
 *   SOCKET_SERVICE_PORT  listen port        (default 3001)
 *   SOCKET_SERVICE_HOST  listen address     (default 0.0.0.0)
 *   WEBUI_SECRET_KEY     JWT secret (shared with the web app)
 *   DATA_DIR             secret-file dir    (default ./data at project root)
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';

const PORT = Number(process.env.SOCKET_SERVICE_PORT || 3001);
const HOST = process.env.SOCKET_SERVICE_HOST || '0.0.0.0';

// This file lives at <project root>/mini-services/socket-service/index.ts.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Secret resolution — identical to the web app (src/lib/auth.ts):
 *   1. WEBUI_SECRET_KEY env var
 *   2. <DATA_DIR>/.webui_secret_key — shared file, auto-created on first run
 *      so a fresh clone works with zero setup (mode 0600)
 *   3. empty → handshake falls back to claim trust (ephemeral filesystems;
 *      set WEBUI_SECRET_KEY in production)
 */
function getSecret(): string {
  if (process.env.WEBUI_SECRET_KEY) return process.env.WEBUI_SECRET_KEY;
  try {
    const dataDir = process.env.DATA_DIR
      ? path.resolve(PROJECT_ROOT, process.env.DATA_DIR)
      : path.join(PROJECT_ROOT, 'data');
    const keyPath = path.join(dataDir, '.webui_secret_key');
    if (fs.existsSync(keyPath)) {
      const existing = fs.readFileSync(keyPath, 'utf-8').trim();
      if (existing) return existing;
    }
    fs.mkdirSync(dataDir, { recursive: true });
    const generated = randomUUID().replace(/-/g, '');
    fs.writeFileSync(keyPath, generated, { mode: 0o600 });
    return generated;
  } catch {
    return '';
  }
}

const io = new Server({
  path: '/ws/socket.io',
  // Polling-only: browsers reach this service through the Next.js /ws proxy
  // (src/app/ws/[...path]/route.ts), which cannot upgrade to WebSocket — a
  // websocket upgrade attempt just hangs. Advertising no upgrades keeps the
  // client deterministically on long-polling, which works end-to-end. A
  // deployment that routes /ws here directly at the edge can re-add
  // 'websocket'.
  transports: ['polling'],
  cors: { origin: '*', credentials: true },
  maxHttpBufferSize: 5e6,
  // Keep-alive for idle/background tabs. The browser throttles JS timers in
  // hidden tabs (down to 1/min after 5 min), which delays the client's pong
  // and — with the old 20s pingTimeout — made the server reap healthy but
  // idle sessions ("ping timeout" → "Connexion perdue. Reconnexion…").
  // pingInterval stays at 25s so every long-poll is answered well within the
  // 60s proxy timeout (src/app/ws/[...path]/route.ts); pingTimeout is widened
  // to 1h so the session (and the client-side watchdog, which derives from
  // these handshake values: pingInterval + pingTimeout) survives an idle
  // background tab for up to an hour without any disconnect.
  pingInterval: 25000,
  pingTimeout: 3600000,
});

const http = createServer((req, res) => {
  const url = req.url ?? '';
  if (url.split('?')[0] === '/emit' && req.method === 'POST') {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      try {
        const { room, event, payload } = JSON.parse(body);
        if (!room) {
          // Broadcast (Python broadcast_event — sio.emit without a room).
          io.emit(String(event ?? 'events'), payload);
        } else {
          io.to(String(room)).emit(String(event ?? 'events'), payload);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":true}');
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: e instanceof Error ? e.message : 'bad request' }));
      }
    });
    return;
  }
  if (url.split('?')[0] === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":true}');
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ detail: 'Not Found' }));
});

io.attach(http, { path: '/ws/socket.io' });

function joinUserRooms(socket: any, token: unknown): void {
  const t = typeof token === 'string' ? token : null;
  if (!t) return;
  try {
    const secret = getSecret();
    const decoded = secret
      ? (jwt.verify(t, secret, { algorithms: ['HS256'] }) as any)
      : (jwt.decode(t) as any); // no secret available — claim trust (ephemeral FS)
    if (decoded?.id) {
      socket.join(`user:${decoded.id}`);
      socket.data.user = {
        id: decoded.id,
        name: decoded.name,
        email: decoded.email,
        role: decoded.role,
      };
    }
  } catch {
    /* invalid token — no room join */
  }
}

io.on('connection', (socket) => {
  // Handshake auth (frontend: auth: (cb) => cb({ token }))
  joinUserRooms(socket, (socket.handshake.auth as any)?.token);

  socket.on('user-join', (data: any, cb?: (r: unknown) => void) => {
    joinUserRooms(socket, data?.auth?.token ?? (socket.handshake.auth as any)?.token);
    cb?.({ status: true });
  });

  socket.on('heartbeat', (_data: unknown, cb?: (r: unknown) => void) => {
    cb?.({ status: true });
  });
});

http.listen(PORT, HOST, () => {
  console.log(`[socket-service] listening on ${HOST}:${PORT} (path /ws/socket.io)`);
});
