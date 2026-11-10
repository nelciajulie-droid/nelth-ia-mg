'use client';

/**
 * Nelth-IA Images — frontend API client.
 *
 * Same-origin calls against the app's existing API surface
 * (/api/v1/imagine/*). Authentication reuses the Open WebUI session token
 * (localStorage "token" as set by the SPA, "owu_token" as set by the React
 * port, or the HttpOnly cookie fallback for <img>-style requests).
 */

import type { ImagineCapabilities, ImagineItem } from './types';

const TOKEN_KEYS = ['token', 'owu_token'] as const;

export function getImagineToken(): string | null {
  if (typeof window === 'undefined') return null;
  for (const key of TOKEN_KEYS) {
    const value = window.localStorage.getItem(key);
    if (value) return value;
  }
  return null;
}

export class ImagineApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body?.detail === 'string' && body.detail.trim()) return body.detail.trim();
    if (Array.isArray(body?.detail) && body.detail.length) {
      const first = body.detail[0] as { msg?: string } | string;
      const msg = typeof first === 'string' ? first : first?.msg;
      if (msg) return msg;
    }
  } catch {
    /* non-JSON body */
  }
  return fallback;
}

/** JSON request with bearer auth (falls back to the session cookie). */
export async function imagineApi<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getImagineToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(`/api/v1/imagine${path}`, { ...init, headers });
  if (!res.ok) {
    throw new ImagineApiError(res.status, await readError(res, `Erreur ${res.status}`));
  }
  return (await res.json()) as T;
}

/** Multipart upload with bearer auth. */
export async function imagineUpload(file: File): Promise<ImagineItem> {
  const form = new FormData();
  form.append('file', file);
  const headers = new Headers();
  const token = getImagineToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch('/api/v1/imagine/upload', { method: 'POST', headers, body: form });
  if (!res.ok) {
    throw new ImagineApiError(res.status, await readError(res, `Erreur ${res.status}`));
  }
  return (await res.json()) as ImagineItem;
}

// ---------------------------------------------------------------------------
// Authenticated image bytes — blob URLs work regardless of cookie state.
// ---------------------------------------------------------------------------

const blobUrlCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

/** Synchronous peek into the resolved blob URL cache (fast remounts). */
export function peekAuthImage(path: string): string | null {
  return blobUrlCache.get(path) ?? null;
}

/** Fetch image bytes with the bearer token → a cached blob: URL. */
export async function authImageUrl(path: string): Promise<string | null> {
  const cached = blobUrlCache.get(path);
  if (cached) return cached;
  const running = inflight.get(path);
  if (running) return running;

  const task = (async () => {
    try {
      const headers = new Headers();
      const token = getImagineToken();
      if (token) headers.set('authorization', `Bearer ${token}`);
      const res = await fetch(path, { headers });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (!blob.size) return null;
      const url = URL.createObjectURL(blob);
      blobUrlCache.set(path, url);
      return url;
    } catch {
      return null;
    } finally {
      inflight.delete(path);
    }
  })();
  inflight.set(path, task);
  return task;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export async function fetchCapabilities(): Promise<ImagineCapabilities> {
  return imagineApi<ImagineCapabilities>('/capabilities');
}

export interface LibraryQuery {
  type?: 'all' | 'generate' | 'edit' | 'variation' | 'upload';
  favorite?: boolean;
  q?: string;
  sinceDays?: number;
  limit?: number;
  offset?: number;
}

export async function fetchItems(query: LibraryQuery = {}): Promise<{ items: ImagineItem[] }> {
  const params = new URLSearchParams();
  if (query.type && query.type !== 'all') params.set('type', query.type);
  if (query.favorite) params.set('favorite', 'true');
  if (query.q?.trim()) params.set('q', query.q.trim());
  if (query.sinceDays) params.set('since_days', String(query.sinceDays));
  params.set('limit', String(query.limit ?? 60));
  params.set('offset', String(query.offset ?? 0));
  return imagineApi<{ items: ImagineItem[] }>(`/items?${params.toString()}`);
}

export async function fetchItem(id: string): Promise<ImagineItem> {
  return imagineApi<ImagineItem>(`/items/${encodeURIComponent(id)}`);
}

export async function patchItem(
  id: string,
  patch: { name?: string; favorite?: boolean }
): Promise<ImagineItem> {
  return imagineApi<ImagineItem>(`/items/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteItem(id: string): Promise<void> {
  await imagineApi<{ status: boolean }>(`/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function generateImages(input: {
  prompt: string;
  aspectRatio?: string;
  style?: string;
  n?: number;
  sourceImages?: Array<{ id?: string; url?: string; name?: string; type?: string }>;
}): Promise<{ items: ImagineItem[] }> {
  return imagineApi<{ items: ImagineItem[] }>('/generate', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function editImage(input: {
  itemId: string;
  prompt: string;
}): Promise<{ item: ImagineItem }> {
  return imagineApi<{ item: ImagineItem }>('/edit', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function variationImage(input: {
  itemId: string;
}): Promise<{ item: ImagineItem }> {
  return imagineApi<{ item: ImagineItem }>('/variations', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Session user shape (subset of GET /api/v1/auths/). */
export interface ImagineSessionUser {
  id: string;
  name: string;
  email: string;
  role: string;
  profile_image_url?: string;
}

/** Resolve the session user with the studio token; null → signed out. */
export async function fetchSession(): Promise<ImagineSessionUser | null> {
  const headers = new Headers();
  const token = getImagineToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  try {
    const res = await fetch('/api/v1/auths/', { headers });
    if (!res.ok) return null;
    const user = (await res.json()) as ImagineSessionUser;
    return user?.id ? user : null;
  } catch {
    return null;
  }
}
