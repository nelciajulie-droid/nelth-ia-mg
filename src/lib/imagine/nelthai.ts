/**
 * Nelthai image generation — Backend V3 client (text→image & image→image).
 *
 * Talks to the Nelth-AI metaai gateway:
 *
 *   Text→image : POST /api/metaai/image/async
 *                body JSON { prompt, mode: 'instant' } → { job_id }
 *   Poll       : GET  /api/metaai/jobs/{job_id}
 *                → { status, result.image_urls[], progress.phase }
 *                phase = 'sending' | 'generating' | 'image' (affiché live
 *                en label de la carte pendant la génération)
 *   Image→image: POST /api/metaai/image-to-image/async
 *                endpoint multipart UNIQUEMENT (JSON rejeté) :
 *                  form.append('prompt', …)
 *                  urls.forEach(u => form.append('image_url', u))
 *                  files.forEach(f => form.append('file', f))
 *                  form.append('mode', 'instant')
 *                → { job_id }
 *
 * The generated images are short-lived CDN URLs (fbcdn & co) — callers must
 * download the bytes immediately (see downloadNelthaiImage).
 */

const NELTHAI_API_BASE = (
  process.env.NELTHAI_API_BASE_URL || 'https://nelthai.space-z.ai'
).replace(/\/+$/, '');

/** Live phases surfaced by the job poller (normalized: 'waiting' → 'sending'). */
export type NelthaiPhase = 'sending' | 'generating' | 'image';

/** One image source for image→image: a remote URL or raw bytes (multipart file). */
export type NelthaiImageSource =
  | { kind: 'url'; url: string }
  | { kind: 'bytes'; bytes: Buffer; filename: string; contentType: string };

export interface NelthaiJob {
  job_id?: string;
  status?: string;
  elapsed_seconds?: number;
  progress?: {
    phase?: string;
    updated_at?: number;
    note?: string;
    image_urls?: string[];
  };
  result?: {
    success?: boolean;
    image_urls?: string[];
    message?: string;
    error?: string;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Normalize the raw progress phase into the three card labels. */
export function normalizePhase(raw: string | null | undefined): NelthaiPhase | null {
  switch (raw) {
    case 'sending':
    case 'waiting':
    case 'pending':
      return 'sending';
    case 'generating':
      return 'generating';
    case 'image':
    case 'done':
    case 'finalizing':
      return 'image';
    default:
      return null;
  }
}

async function parseError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.clone().json();
    const detail =
      (body && typeof body === 'object' && (body.detail || body.error)) || null;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
    if (detail && typeof detail === 'object') {
      const msg = (detail as any).message || (detail as any).error;
      if (typeof msg === 'string' && msg.trim()) return msg.trim();
    }
  } catch {
    /* non-JSON error body */
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Job submission
// ---------------------------------------------------------------------------

/** Text→image — returns the job id to poll. */
export async function submitNelthaiTextToImage(prompt: string): Promise<string> {
  if (!prompt || !prompt.trim()) throw new Error('Prompt is required for image generation');
  const res = await fetch(`${NELTHAI_API_BASE}/api/metaai/image/async`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: prompt.trim(), mode: 'instant' }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Nelthai submit failed: ${await parseError(res, `HTTP ${res.status}`)}`);
  const body = (await res.json()) as { job_id?: string };
  if (!body?.job_id) throw new Error('Nelthai submit failed: no job_id in response');
  return body.job_id;
}

/**
 * Image→image — multipart ONLY (the endpoint rejects JSON bodies).
 * Sources may mix remote URLs (`image_url`, repeatable) and raw file uploads
 * (`file`, repeatable) in a single form.
 */
export async function submitNelthaiImageToImage(
  prompt: string,
  sources: NelthaiImageSource[]
): Promise<string> {
  if (!prompt || !prompt.trim()) throw new Error('Prompt is required for image generation');
  const usable = (sources ?? []).filter((s) =>
    s && ((s.kind === 'url' && /^https?:\/\//i.test(s.url)) || (s.kind === 'bytes' && s.bytes?.length))
  );
  if (!usable.length) {
    throw new Error('Image-to-image requires at least one image (URL or file)');
  }

  const form = new FormData();
  form.append('prompt', prompt.trim());
  for (const source of usable) {
    if (source.kind === 'url') {
      form.append('image_url', source.url);
    } else {
      form.append(
        'file',
        new File([new Uint8Array(source.bytes)], source.filename || 'input.png', {
          type: source.contentType || 'image/png',
        })
      );
    }
  }
  form.append('mode', 'instant');

  const res = await fetch(`${NELTHAI_API_BASE}/api/metaai/image-to-image/async`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Nelthai submit failed: ${await parseError(res, `HTTP ${res.status}`)}`);
  const body = (await res.json()) as { job_id?: string };
  if (!body?.job_id) throw new Error('Nelthai submit failed: no job_id in response');
  return body.job_id;
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/** Single job snapshot fetch. */
export async function getNelthaiJob(jobId: string): Promise<NelthaiJob> {
  const res = await fetch(`${NELTHAI_API_BASE}/api/metaai/jobs/${encodeURIComponent(jobId)}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Nelthai poll failed: HTTP ${res.status}`);
  return (await res.json()) as NelthaiJob;
}

export interface WaitForNelthaiOptions {
  /** Fired on every live phase CHANGE (label of the generation card). */
  onPhase?: (phase: NelthaiPhase) => void;
  /** Overall budget (default 180s — observed generations run 15-40s). */
  timeoutMs?: number;
  /** Poll interval (default 1.5s; 500ms floor). */
  pollMs?: number;
}

function imageUrlsOf(job: NelthaiJob): string[] {
  const urls = [
    ...(job.result?.image_urls ?? []),
    ...(job.progress?.image_urls ?? []),
  ].filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u));
  return [...new Set(urls)];
}

/**
 * Poll a job until it completes → the generated image URLs.
 *
 * Phase transitions (sending → generating → image) are surfaced through
 * `onPhase` the moment the poller sees them — the UI shows them live as the
 * label of the generating card. Throws when the job fails or times out.
 */
export async function waitForNelthaiImages(
  jobId: string,
  options: WaitForNelthaiOptions = {}
): Promise<string[]> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const pollMs = Math.max(500, options.pollMs ?? 1_500);
  const startedAt = Date.now();
  let lastPhase: NelthaiPhase | null = null;
  let lastError: unknown = null;

  // The gateway occasionally answers a poll with a 5xx blip — tolerate a few
  // in a row before giving up (the job itself keeps running server-side).
  let consecutiveErrors = 0;

  for (;;) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `Image generation timed out after ${Math.round(timeoutMs / 1000)}s` +
          (lastError instanceof Error ? ` (last poll error: ${lastError.message})` : '')
      );
    }
    try {
      const job = await getNelthaiJob(jobId);
      consecutiveErrors = 0;

      const phase = normalizePhase(job.progress?.phase);
      if (phase && phase !== lastPhase) {
        lastPhase = phase;
        options.onPhase?.(phase);
      }

      if (job.status === 'done' || job.status === 'completed' || job.status === 'succeeded') {
        const urls = imageUrlsOf(job);
        if (!urls.length) {
          const detail =
            job.result?.error || job.result?.message || 'the job finished without images';
          throw new Error(`Image generation failed: ${detail}`);
        }
        // Make sure the terminal 'image' phase was surfaced before resolving.
        if (lastPhase !== 'image') options.onPhase?.('image');
        return urls;
      }

      if (job.status === 'failed' || job.status === 'error' || job.status === 'cancelled') {
        const detail =
          job.result?.error || job.result?.message || job.progress?.note || job.status;
        throw new Error(`Image generation failed: ${detail}`);
      }
    } catch (e) {
      // A terminal outcome parsed above must propagate immediately.
      if (e instanceof Error && e.message.startsWith('Image generation')) throw e;
      lastError = e;
      if (++consecutiveErrors >= 5) {
        throw new Error(
          `Image generation failed: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------------------
// Result download
// ---------------------------------------------------------------------------

/** Download one generated image → raw bytes + content type (URLs expire fast). */
export async function downloadNelthaiImage(url: string): Promise<{
  bytes: Buffer;
  contentType: string;
}> {
  const res = await fetch(url, {
    headers: { accept: 'image/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Failed to download the generated image (HTTP ${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1024) throw new Error('The image service returned an empty image');
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
  return { bytes, contentType: contentType.startsWith('image/') ? contentType : 'image/png' };
}
