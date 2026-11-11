/**
 * Nelth-IA Images — frontend API client (standalone bundle).
 *
 * Same-origin calls against the app's existing API surface
 * (/api/v1/imagine/*). Authentication reuses the Open WebUI session token
 * (localStorage "token" as set by the SPA, "owu_token" as set by the React
 * port, or the cookie fallback for <img>-style requests).
 */

import type { ImagineCapabilities, ImagineItem } from '../lib/images/types';

/** Type de média demandé au studio. */
export type MediaKind = 'image' | 'video' | 'gif';
/** Modèle d'image sélectionné (segment Nelth-V2 | Nelth-V3). */
export type ImagineModel = 'v2' | 'v3';
/** Résolution vidéo (segment 480p | 720p). */
export type VideoResolutionChoice = '480p' | '720p';

const TOKEN_KEYS = ['token', 'owu_token'] as const;

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  for (const key of TOKEN_KEYS) {
    const value = window.localStorage.getItem(key);
    if (value) return value;
  }
  return null;
}

export class ImagesApiError extends Error {
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
    /* corps non-JSON */
  }
  return fallback;
}

/** Requête JSON avec Bearer (repli sur le cookie de session). */
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(`/api/v1/imagine${path}`, { ...init, headers });
  if (!res.ok) {
    throw new ImagesApiError(res.status, await readError(res, `Erreur ${res.status}`));
  }
  return (await res.json()) as T;
}

export async function fetchCapabilities(): Promise<ImagineCapabilities> {
  return api<ImagineCapabilities>('/capabilities');
}

export async function fetchItems(limit = 120): Promise<ImagineItem[]> {
  const { items } = await api<{ items: ImagineItem[] }>(`/items?limit=${limit}`);
  return items;
}

export interface GenerateInput {
  prompt: string;
  /** Catégorie de média : image (défaut), vidéo ou GIF. */
  kind?: MediaKind;
  /** Modèle d'image : 'v2' (vibes) ou 'v3' (nelthai). GIF = toujours v3. */
  model?: ImagineModel;
  /** Résolution vidéo — catégorie vidéo uniquement. */
  resolution?: VideoResolutionChoice;
  aspectRatio?: string;
  style?: string;
  /** Nombre de variations (1-4) — verrouillé à 1 par le serveur en i2i V2 / i2v. */
  n?: number;
  sourceImages?: Array<{ id?: string; url?: string; name?: string; type?: string }>;
}

export async function generate(input: GenerateInput): Promise<ImagineItem[]> {
  const body = await api<{ items?: ImagineItem[] }>('/generate', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) {
    throw new ImagesApiError(502, 'Réponse inattendue du serveur — aucune image mise en file.');
  }
  return items;
}

export async function editItem(itemId: string, prompt: string): Promise<ImagineItem> {
  const { item } = await api<{ item?: ImagineItem }>('/edit', {
    method: 'POST',
    body: JSON.stringify({ itemId, prompt }),
  });
  if (!item?.id) {
    throw new ImagesApiError(502, 'Réponse inattendue du serveur — édition non mise en file.');
  }
  return item;
}

export async function variationItem(itemId: string): Promise<ImagineItem> {
  const { item } = await api<{ item?: ImagineItem }>('/variations', {
    method: 'POST',
    body: JSON.stringify({ itemId }),
  });
  if (!item?.id) {
    throw new ImagesApiError(502, 'Réponse inattendue du serveur — variation non mise en file.');
  }
  return item;
}

export async function uploadImage(file: File): Promise<ImagineItem> {
  const form = new FormData();
  form.append('file', file);
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch('/api/v1/imagine/upload', { method: 'POST', headers, body: form });
  if (!res.ok) {
    throw new ImagesApiError(res.status, await readError(res, `Erreur ${res.status}`));
  }
  return (await res.json()) as ImagineItem;
}

export async function patchItem(
  id: string,
  body: { name?: string; favorite?: boolean }
): Promise<ImagineItem> {
  return api<ImagineItem>(`/items/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteItem(id: string): Promise<void> {
  await api<{ status: boolean }>(`/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Octets d'image authentifiés — blob URLs (fonctionnent quel que soit l'état
// du cookie). Cache module-level : les grilles re-montent instantanément.
// ---------------------------------------------------------------------------

const blobUrlCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

export function peekImage(path: string): string | null {
  return blobUrlCache.get(path) ?? null;
}

export async function authImageUrl(path: string): Promise<string | null> {
  const cached = blobUrlCache.get(path);
  if (cached) return cached;
  const running = inflight.get(path);
  if (running) return running;

  const task = (async () => {
    try {
      const headers = new Headers();
      const token = getToken();
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

/** Télécharge les octets authentifiés et déclenche le téléchargement navigateur. */
export async function downloadImage(path: string, filename: string): Promise<boolean> {
  const url = await authImageUrl(path);
  if (!url) return false;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'image.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return true;
}
