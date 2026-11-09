/**
 * Nelth vibes video generation — backend client (text→video, image→video).
 *
 * Talks to the Nelth vibes gateway (https://nelcia.space-z.ai):
 *
 *   Text→video : POST /api/vibes/videos/generate
 *                body JSON { project_id, prompt, aspect_ratio, resolution,
 *                            variations, poll: false } → { batchId }
 *   Upload     : POST /api/vibes/upload/media  (multipart: file, filename,
 *                project_id) → { mediaEntId, imageUrl } — registers an image
 *                into the vibes media store, prerequisite for animate
 *   Image→video: POST /api/vibes/videos/animate
 *                body JSON { project_id, prompt (motion), poll: false,
 *                            source_image: { id, imageUrl, mediaEntId,
 *                            prompt } } → { batchId }
 *   Poll batch : POST /api/vibes/batches/{batchId}/poll?timeout=5
 *                (GET is rejected with 405 — POST only) →
 *                { isComplete, hasError, error, content: [{ videoUrl }] }
 *
 * The generated videos are short-lived CDN URLs (fbcdn) — callers must
 * download the bytes immediately (see downloadVibesVideo).
 */

const VIBES_API_BASE = (
  process.env.VIBES_API_BASE_URL || 'https://nelcia.space-z.ai'
).replace(/\/+$/, '');

const VIBES_PROJECT_ID = process.env.VIBES_PROJECT_ID || '8dbdbb11-0b6a-4ddb-8f06-e090af291630';

export type VibesAspectRatio = '1:1' | '16:9' | '9:16';
export type VibesResolution = '480p' | '720p';

const RATIOS: VibesAspectRatio[] = ['1:1', '16:9', '9:16'];
const RESOLUTIONS: VibesResolution[] = ['480p', '720p'];

export function normalizeVibesAspectRatio(raw: string | null | undefined): VibesAspectRatio {
  return RATIOS.includes(raw as VibesAspectRatio) ? (raw as VibesAspectRatio) : '16:9';
}

export function normalizeVibesResolution(raw: string | null | undefined): VibesResolution {
  return RESOLUTIONS.includes(raw as VibesResolution) ? (raw as VibesResolution) : '480p';
}

async function parseError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.clone().json();
    const detail =
      body && typeof body === 'object' && (body.detail || body.error) != null
        ? body.detail ?? body.error
        : null;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
    if (detail && typeof detail === 'object') {
      const msg = (detail as any).detail ?? (detail as any).message ?? (detail as any).title;
      if (typeof msg === 'string' && msg.trim()) return msg.trim();
    }
  } catch {
    /* non-JSON error body */
  }
  return fallback;
}

/** Shared POST helper — JSON in, JSON out, typed timeout. */
async function vibesFetch<T>(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<T> {
  const res = await fetch(`${VIBES_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(await parseError(res, `HTTP ${res.status}`));
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Text→video — async batch submission
// ---------------------------------------------------------------------------

export async function vibesGenerateVideo(input: {
  prompt: string;
  aspectRatio?: VibesAspectRatio;
  resolution?: VibesResolution;
  variations?: number;
}): Promise<{ batchId: string }> {
  if (!input.prompt || !input.prompt.trim()) {
    throw new Error('Prompt is required for video generation');
  }
  const data = await vibesFetch<{ success?: boolean; batchId?: string; error?: string }>(
    '/api/vibes/videos/generate',
    {
      project_id: VIBES_PROJECT_ID,
      prompt: input.prompt.trim(),
      aspect_ratio: normalizeVibesAspectRatio(input.aspectRatio),
      resolution: normalizeVibesResolution(input.resolution),
      variations: Math.min(Math.max(input.variations ?? 1, 1), 4),
      poll: false, // OUR poller drives the batch to completion
    },
    30_000
  );
  if (!data?.batchId) throw new Error(data?.error || 'No batchId returned by the video gateway');
  return { batchId: data.batchId };
}

// ---------------------------------------------------------------------------
// Batch polling (shared by both generation directions)
// ---------------------------------------------------------------------------

export interface VibesBatchContent {
  id: string;
  videoUrl?: string | null;
  imageUrl?: string | null;
  isLoading?: boolean;
}

export interface VibesBatch {
  id: string;
  isComplete?: boolean;
  hasError?: boolean;
  error?: string | null;
  content?: VibesBatchContent[];
}

/**
 * Single batch snapshot — POST is mandatory (GET answers 405). The gateway
 * holds the poll open for `timeout` seconds when the batch is still running
 * (long-poll style), which is why the fetch timeout is generous.
 */
export async function vibesPollBatch(batchId: string): Promise<VibesBatch> {
  return vibesFetch<VibesBatch>(
    `/api/vibes/batches/${encodeURIComponent(batchId)}/poll?timeout=5`,
    {},
    25_000
  );
}

// ---------------------------------------------------------------------------
// Image upload — registers an image into the vibes project media store
// ---------------------------------------------------------------------------

export interface VibesUploadedMedia {
  mediaEntId: string;
  imageUrl: string;
  sourceImageEntId?: string;
  registered?: boolean;
}

/**
 * Upload raw image bytes to the vibes media library (multipart ONLY, exactly
 * like the studio frontend: fields `file`, `filename`, `project_id`).
 *
 * This is the ONLY way to animate an arbitrary image: the animate endpoint
 * resolves its `source_image.mediaEntId` against the vibes-side store — a
 * bare public URL is rejected with MEDIA_GONE.
 */
export async function vibesUploadImage(input: {
  bytes: Buffer;
  filename?: string;
  contentType?: string;
}): Promise<VibesUploadedMedia> {
  if (!input.bytes?.length) throw new Error('Image bytes are required for the vibes upload');
  const form = new FormData();
  form.append(
    'file',
    new File([new Uint8Array(input.bytes)], input.filename || 'input.png', {
      type: input.contentType || 'image/png',
    })
  );
  form.append('filename', input.filename || 'input.png');
  form.append('project_id', VIBES_PROJECT_ID);

  const res = await fetch(`${VIBES_API_BASE}/api/vibes/upload/media`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(await parseError(res, `HTTP ${res.status}`));
  const body = (await res.json()) as Partial<VibesUploadedMedia> & { error?: string };
  const mediaEntId = body?.mediaEntId || body?.sourceImageEntId;
  if (!mediaEntId || !body?.imageUrl) {
    throw new Error(body?.error || 'The vibes upload returned no mediaEntId');
  }
  return {
    mediaEntId,
    imageUrl: body.imageUrl,
    sourceImageEntId: body.sourceImageEntId ?? mediaEntId,
    registered: body.registered,
  };
}

// ---------------------------------------------------------------------------
// Image→video (animate) — source_image + motion prompt
// ---------------------------------------------------------------------------

export async function vibesAnimateVideo(input: {
  source: { mediaEntId: string; imageUrl: string; prompt?: string };
  motion?: string;
}): Promise<{ batchId: string }> {
  const data = await vibesFetch<{ batchId?: string; batch?: { id?: string }; id?: string; error?: string }>(
    '/api/vibes/videos/animate',
    {
      project_id: VIBES_PROJECT_ID,
      prompt: (input.motion || '').trim() || undefined, // motion directive — optional
      poll: false,
      source_image: {
        id: input.source.mediaEntId,
        imageUrl: input.source.imageUrl,
        mediaEntId: input.source.mediaEntId,
        prompt: input.source.prompt ?? 'Uploaded image',
      },
    },
    30_000
  );
  const batchId = data?.batchId || data?.batch?.id || data?.id;
  if (!batchId) throw new Error(data?.error || 'No batchId returned by the animate endpoint');
  return { batchId };
}

// ---------------------------------------------------------------------------
// Result download
// ---------------------------------------------------------------------------

/** Download one generated video → raw bytes (CDN URLs expire fast). */
export async function downloadVibesVideo(url: string): Promise<{
  bytes: Buffer;
  contentType: string;
}> {
  const res = await fetch(url, {
    headers: { accept: 'video/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Failed to download the generated video (HTTP ${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 20_000) throw new Error('The video service returned an empty video');
  // Sanity: a real MP4 starts with an ftyp box within the first bytes.
  const head = bytes.subarray(0, 64).toString('latin1');
  if (!head.includes('ftyp')) throw new Error('The video service returned a non-MP4 payload');
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
  return { bytes, contentType: contentType.startsWith('video/') ? contentType : 'video/mp4' };
}
