/**
 * Port of open_webui/socket/main.py publish_event / broadcast_event.
 *
 * The compiled frontend listens to the socket 'events' channel with the
 * envelope `{ chat_id?, message_id?, data: { type, data } }` and dispatches
 * on `data.type` — e.g. 'models:refresh' (all tabs re-fetch /api/models),
 * 'page:reload', 'theme:update', 'query'. Emission goes through the
 * co-located socket-service internal endpoint (best-effort, like Python).
 */
import { emitSocketEvent } from '@/lib/chat/socket-events';

/** Emit an event to one user's room (Python: publish_event(user_id, ...)). */
export async function publishEvent(
  userId: string,
  type: string,
  data: unknown = null,
  extra: { chat_id?: string | null; message_id?: string | null } = {}
): Promise<void> {
  await emitSocketEvent(`user:${userId}`, {
    data: { type, data },
    ...extra,
  });
}

/**
 * Emit an event to every connected client (Python: broadcast_event — sio.emit
 * without a room). The socket-service treats a missing room as a broadcast.
 */
export async function broadcastEvent(
  type: string,
  data: unknown = null,
  extra: { chat_id?: string | null; message_id?: string | null } = {}
): Promise<void> {
  await emitSocketEvent('', {
    data: { type, data },
    ...extra,
  });
}
