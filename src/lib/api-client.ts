/**
 * Tiny same-origin fetch wrapper for the Open WebUI (TS port) API.
 *
 * - Bearer token is read from localStorage("owu_token"); when absent the
 *   request relies on the HttpOnly `token` cookie set at signin.
 * - All errors are normalised to `ApiError` carrying the server `detail`.
 * - `streamChatCompletion` parses the SSE protocol used by
 *   POST /api/chat/completions (data: {...choices[0].delta.content}\n\n ... data: [DONE]).
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

export interface StreamCallbacks {
  onDelta: (content: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

export interface StreamChatOptions {
  model: string;
  messages: Array<{ role: string; content: string; files?: unknown[] }>;
  chat_id?: string;
  signal?: AbortSignal;
}

/**
 * POST /api/chat/completions with stream:true and iterate the SSE response,
 * forwarding each `choices[0].delta.content` chunk to `onDelta`.
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
    }),
  });

  if (!res.ok) throw await extractError(res);
  if (!res.body) throw new ApiError("Streaming is not supported by this connection", 501);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleEventData = (raw: string) => {
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      if (payload === "[DONE]") {
        return;
      }
      try {
        const obj = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string | null } }>;
          error?: { message?: string } | string;
        };
        if (obj.error) {
          const message =
            typeof obj.error === "string" ? obj.error : obj.error.message ?? "Stream error";
          callbacks.onError?.(message);
          continue;
        }
        const delta = obj.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) callbacks.onDelta(delta);
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
