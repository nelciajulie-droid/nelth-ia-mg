/**
 * Socket event emission — Python socket/main.py get_event_emitter parity.
 *
 * The chat pipeline emits `sio.emit('events', {chat_id, message_id, data},
 * room='user:{user_id}') through the socket-service internal endpoint.
 * Location is configurable via SOCKET_SERVICE_URL (default co-located service).
 */
const SOCKET_SERVICE_URL = process.env.SOCKET_SERVICE_URL || 'http://127.0.0.1:3001';

export async function emitSocketEvent(room: string, payload: unknown): Promise<void> {
  try {
    await fetch(`${SOCKET_SERVICE_URL}/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room, event: 'events', payload }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* socket service unavailable — events are best-effort (UI degrades to reload) */
  }
}

/** Envelope parity: {chat_id, message_id, data} → room user:{user_id}. */
export function makeEventEmitter(userId: string) {
  return async (chatId: string, messageId: string | null, data: unknown): Promise<void> => {
    await emitSocketEvent(`user:${userId}`, { chat_id: chatId, message_id: messageId, data });
  };
}
