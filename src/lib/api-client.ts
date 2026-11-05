/**
 * Tiny same-origin fetch wrapper for the Open WebUI (TS port) API.
 *
 * - Bearer token is read from localStorage("owu_token"); when absent the
 *   request relies on the HttpOnly `token` cookie set at signin.
 * - All errors are normalised to `ApiError` carrying the server `detail`.
 * - `streamChatCompletion` parses the SSE protocol used by
 *   POST /api/chat/completions. It requests the UI event transport
 *   (`session_id` + `__sse_events`) so the whole socket event flow —
 *   status (live image-generation phases), chat:message:files (generated
 *   images), titles, structured reasoning snapshots and plain content
 *   deltas — arrives as ordered SSE envelopes on the HTTP response itself:
 *     data: {chat_id, message_id, data: {type: '…', data: {…}}}\n\n
 */

const TOKEN_KEY = "owu_token";

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore quota/privacy errors */
  }
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function extractError(res: Response): Promise<ApiError> {
  let message = `Request failed (${res.status})`;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "detail" in body) {
      const detail = (body as { detail: unknown }).detail;
      if (typeof detail === "string") message = detail;
      else if (detail && typeof detail === "object" && "message" in detail) {
        message = String((detail as { message: unknown }).message);
      } else if (detail != null) {
        message = JSON.stringify(detail);
      }
    }
  } catch {
    /* non-JSON body — keep generic message */
  }
  return new ApiError(message, res.status);
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Set false for public endpoints (no bearer header). */
  auth?: boolean;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { method = "GET", body, auth = true, signal } = options;
  const headers: Record<string, string> = {};
  if (auth) Object.assign(headers, authHeaders());
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    signal,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await extractError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/** Upload a file via multipart POST /api/v1/files/ and return its id + name. */
export async function uploadFile(file: globalThis.File): Promise<{ id: string; name: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/v1/files/", {
    method: "POST",
    headers: authHeaders(),
    credentials: "same-origin",
    body: form,
  });
  if (!res.ok) throw await extractError(res);
  const data = (await res.json()) as { id: string; filename?: string };
  return { id: data.id, name: data.filename ?? file.name };
}

// ---------------------------------------------------------------------------
// SSE streaming
// ---------------------------------------------------------------------------

/** Status event (socket `status` envelope) — image-generation phases etc. */
export interface StreamStatusEvent {
  action?: string;
  description?: string;
  done?: boolean;
}

/** Generated-image result file (chat:message:files envelope). */
export interface StreamImageFile {
  type: string;
  url: string;
  name?: string;
}

/** One block of a structured output snapshot (chat:completion `output`). */
export interface OutputSnapshotItem {
  type?: string;
  attributes?: Record<string, unknown>;
  content?: Array<{ type?: string; text?: string }>;
  status?: string;
  [key: string]: unknown;
}

export interface StreamCallbacks {
  onDelta: (content: string) => void;
  /** Structured output snapshots (reasoning models) — full replacement. */
  onOutputSnapshot?: (output: OutputSnapshotItem[]) => void;
  /** Live status events (image-generation phase labels, …). */
  onStatus?: (status: StreamStatusEvent) => void;
  /** Generated image files landing (ends the image-generation card). */
  onFiles?: (files: StreamImageFile[]) => void;
  /** Server-side chat title update. */
  onTitle?: (title: string) => void;
  onError?: (message: string) => void;
  onDone?: () => void;
}

export interface StreamChatOptions {
  model: string;
  messages: Array<{ role: string; content: string; files?: unknown[] }>;
  chat_id?: string;
  signal?: AbortSignal;
  /** Assistant message wire id — the flow persists the exchange against it. */
  id?: string;
  /** The turn's user message (id + content + attachments) for persistence. */
  user_message?: {
    id: string;
    role: string;
    content: string;
    files?: unknown[];
  };
  /** Server-side background tasks (title generation, …). */
  background_tasks?: Record<string, unknown>;
}

/**
 * Extract the visible answer text out of a structured output snapshot
 * (`message` blocks only — reasoning blocks are the thinking UI's business).
 */
export function outputSnapshotText(output: OutputSnapshotItem[] | undefined | null): string {
  if (!Array.isArray(output)) return "";
  let text = "";
  for (const item of output) {
    if (item?.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (typeof part?.text === "string") text += part.text;
    }
  }
  return text;
}

/**
 * POST /api/chat/completions with the UI event transport (session_id +
 * __sse_events) and iterate the SSE response. Each envelope
 * `{chat_id, message_id, data: {type, data}}` is dispatched to its callback:
 * chat:completion (plain `choices[0].delta.content` deltas or structured
 * `output` snapshots), status (live image-generation phases),
 * chat:message:files (generated images), chat:title, chat:message:error.
 * Legacy bare OpenAI chunks are still understood for API-client parity.
 */
export async function streamChatCompletion(
  options: StreamChatOptions,
  callbacks: StreamCallbacks
): Promise<void> {
  const res = await fetch("/api/chat/completions", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    signal: options.signal,
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      stream: true,
      chat_id: options.chat_id,
      ...(options.id ? { id: options.id } : {}),
      ...(options.user_message ? { user_message: options.user_message } : {}),
      ...(options.background_tasks ? { background_tasks: options.background_tasks } : {}),
      // UI event transport: the whole socket event flow (status, files,
      // deltas, titles) is serialized into this SSE response.
      session_id: crypto.randomUUID(),
      __sse_events: true,
    }),
  });

  if (!res.ok) throw await extractError(res);
  if (!res.body) throw new ApiError("Streaming is not supported by this connection", 501);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleEnvelope = (envelope: {
    data?: { type?: string; data?: Record<string, unknown> };
    choices?: Array<{ delta?: { content?: string | null } }>;
    error?: { message?: string } | string;
  }) => {
    // Legacy bare OpenAI chunk (API-client parity).
    if (!envelope?.data?.type) {
      if (envelope.error) {
        const message =
          typeof envelope.error === "string" ? envelope.error : envelope.error.message ?? "Stream error";
        callbacks.onError?.(message);
        return;
      }
      const delta = envelope.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) callbacks.onDelta(delta);
      return;
    }

    const type = envelope.data.type;
    const payload = envelope.data.data ?? {};
    switch (type) {
      case "chat:completion": {
        if (Array.isArray(payload.output)) {
          callbacks.onOutputSnapshot?.(payload.output as OutputSnapshotItem[]);
        }
        const choices = payload.choices as Array<{ delta?: { content?: string | null } }> | undefined;
        const delta = choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) callbacks.onDelta(delta);
        break;
      }
      case "status":
        callbacks.onStatus?.({
          action: typeof payload.action === "string" ? payload.action : undefined,
          description: typeof payload.description === "string" ? payload.description : undefined,
          done: payload.done === true,
        });
        break;
      case "chat:message:files": {
        const files = Array.isArray(payload.files) ? payload.files : [];
        const imageFiles = files
          .filter((f): f is StreamImageFile => !!f && typeof (f as StreamImageFile).url === "string")
          .map((f) => ({
            type: typeof f.type === "string" ? f.type : "image",
            url: f.url,
            name: typeof f.name === "string" ? f.name : undefined,
          }));
        if (imageFiles.length) callbacks.onFiles?.(imageFiles);
        break;
      }
      case "chat:title":
        if (typeof payload === "string" || typeof (payload as { title?: unknown }).title === "string") {
          callbacks.onTitle?.(
            typeof payload === "string" ? payload : String((payload as { title: string }).title)
          );
        }
        break;
      case "chat:message:error": {
        const error = (payload as { error?: { content?: string } | string }).error;
        const message =
          typeof error === "string" ? error : error?.content ?? "Stream error";
        callbacks.onError?.(message);
        break;
      }
      default:
        /* chat:list, sources, … — not consumed by this client yet */
        break;
    }
  };

  const handleEventData = (raw: string) => {
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]" || payload === "null") continue;
      try {
        handleEnvelope(JSON.parse(payload));
      } catch {
        /* partial JSON in a keep-alive frame — ignore */
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let separator: number;
      while ((separator = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        handleEventData(event);
      }
    }
    if (buffer.trim().length > 0) handleEventData(buffer);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
    callbacks.onDone?.();
  }
}

// ---------------------------------------------------------------------------
// Title generation
// ---------------------------------------------------------------------------

/** Parse a title out of a /api/v1/tasks/title/completions response. */
export function extractGeneratedTitle(content: string | undefined | null): string | null {
  if (!content) return null;
  const stripped = content
    .replace(/```json\s*/gi, "")
    .replace(/```\s*$/g, "")
    .trim();
  const jsonMatch = stripped.match(/\{\s*"title"\s*:\s*"([^"]+)"\s*\}/);
  if (jsonMatch) return jsonMatch[1].trim();
  try {
    const parsed = JSON.parse(stripped) as { title?: unknown };
    if (typeof parsed.title === "string" && parsed.title.trim()) return parsed.title.trim();
  } catch {
    /* fall through */
  }
  const cleaned = stripped.replace(/["`]/g, "").trim();
  if (cleaned && cleaned.length <= 80) return cleaned;
  return null;
}
