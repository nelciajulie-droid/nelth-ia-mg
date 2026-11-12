/**
 * Nelth-AI Documents — client API du bundle autonome.
 *
 * Appels same-origin sur la surface /api/v1/documents (listes, détail,
 * édition, amélioration IA, export, suppression). L'authentification réutilise
 * le jeton de session Open WebUI (localStorage « token » du SPA, « owu_token »
 * du port React) en Bearer — mêmes conventions que le bundle Images.
 *
 * Les types DocumentDoc / DocSheet / DocSlide proviennent du schéma SDR
 * partagé (import type — purement effacé au build, zod n'est pas embarqué).
 */

import type { DocumentDoc } from '../lib/documents/core/document-schema';

const TOKEN_KEYS = ['token', 'owu_token'] as const;

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  for (const key of TOKEN_KEYS) {
    const value = window.localStorage.getItem(key);
    if (value) return value;
  }
  return null;
}

export class DocumentsApiError extends Error {
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

/** Requête JSON avec Bearer (repli implicite sur le cookie de session). */
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(`/api/v1/documents${path}`, { ...init, headers });
  if (!res.ok) {
    throw new DocumentsApiError(res.status, await readError(res, `Erreur ${res.status}`));
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Types de réponse
// ---------------------------------------------------------------------------

export type TemplateInfo = {
  id: string;
  name: string;
  description: string;
  layout: 'editorial' | 'bold';
  family: 'sans' | 'serif';
  bestFor: string[];
  palette: {
    accent: string;
    accent2: string;
    accentDark: string;
    tint: string;
    ink: string;
    body: string;
    muted: string;
    zebra: string;
    hairline: string;
  };
};

export type RevisionEntry = {
  seq: number;
  at: number;
  by: 'human' | 'ai' | 'create';
  note: string | null;
  title: string | null;
};

/** Champs résumé renvoyés par GET / PATCH / improve. */
export type DocumentMeta = {
  id: string;
  file_id: string;
  title: string;
  docType: string;
  template: string;
  language: string;
  format: string;
  filename: string;
  url: string;
  size: number;
  updated_at: number;
  created_at: number;
  chat_id: string | null;
  message_id: string | null;
  blockCount: number;
  sheetCount: number;
  slideCount: number;
};

export type DocumentDetail = DocumentMeta & {
  typeLabel: string;
  document: DocumentDoc;
  revisions: RevisionEntry[];
  exportFormats: string[];
};

/** Réponse PATCH / improve (révisions absentes du payload). */
export type MutationResponse = DocumentMeta & {
  typeLabel: string;
  document: DocumentDoc;
  note?: string;
  saved_at?: number;
};

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export async function fetchTemplates(): Promise<{
  templates: TemplateInfo[];
  formats: string[];
}> {
  return api<{ templates: TemplateInfo[]; formats: string[] }>('/templates');
}

export async function fetchDocument(id: string): Promise<DocumentDetail> {
  return api<DocumentDetail>(`/${encodeURIComponent(id)}`);
}

export type PatchBody = {
  document?: DocumentDoc;
  title?: string;
  template?: string;
  language?: string;
  note?: string;
};

export async function patchDocument(id: string, body: PatchBody): Promise<MutationResponse> {
  return api<MutationResponse>(`/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function improveDocument(id: string, instruction: string): Promise<MutationResponse> {
  return api<MutationResponse>(`/${encodeURIComponent(id)}/improve`, {
    method: 'POST',
    body: JSON.stringify({ instruction }),
  });
}

export async function deleteDocument(id: string): Promise<void> {
  await api<{ message: string }>(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Nom de fichier depuis l'en-tête content-disposition (forme RFC 5987 prioritaire). */
function filenameFromDisposition(cd: string | null, fallback: string): string {
  if (!cd) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* encodage invalide — repli */
    }
  }
  const plain = /filename="([^"]+)"/i.exec(cd);
  if (plain) return plain[1];
  return fallback;
}

/**
 * Export — télécharge les octets réels (PDF, DOCX…) via un blob authentifié
 * et déclenche le téléchargement navigateur avec le nom du serveur.
 */
export async function downloadExport(id: string, format: string): Promise<string> {
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(
    `/api/v1/documents/${encodeURIComponent(id)}/export?format=${encodeURIComponent(format)}`,
    { headers }
  );
  if (!res.ok) {
    throw new DocumentsApiError(res.status, await readError(res, `Erreur ${res.status}`));
  }
  const blob = await res.blob();
  const filename = filenameFromDisposition(res.headers.get('content-disposition'), `document.${format}`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  return filename;
}

// ---------------------------------------------------------------------------
// Images authentifiées dans les documents (blocs image) — blob URLs via
// Bearer, cache module-level (les pages re-montent instantanément).
// ---------------------------------------------------------------------------

const blobUrlCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

export function peekBlob(path: string): string | null {
  return blobUrlCache.get(path) ?? null;
}

export async function authBlobUrl(path: string): Promise<string | null> {
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
