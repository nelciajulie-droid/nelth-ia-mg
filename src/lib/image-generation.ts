import type { ApiUser } from '@/lib/auth';
import {
  submitNelthaiTextToImage,
  submitNelthaiImageToImage,
  waitForNelthaiImages,
  downloadNelthaiImage,
  normalizePhase,
  type NelthaiImageSource,
  type NelthaiPhase,
} from '@/lib/imagine/nelthai';
import { db } from '@/lib/db';

/**
 * Built-in image generation engine — Nelthai metaai gateway (Backend V3).
 *
 * Replaces the earlier keyless Pollinations engine: real Meta-AI-quality
 * generations through the Nelth-AI gateway (https://nelthai.space-z.ai) with
 * BOTH directions:
 *
 *   • text→image  — POST /api/metaai/image/async          (async job + poll)
 *   • image→image — POST /api/metaai/image-to-image/async (multipart ONLY)
 *
 * It is used:
 *   - by POST /api/v1/images/generations when the configured engine has no
 *     API key (or when IMAGE_GENERATION_ENGINE === 'sd'),
 *   - by POST /api/v1/images/edit for image→image transformations,
 *   - by the chat pipeline when the selected model is the built-in
 *     `stable-diffusion-xl` model or the image-generation feature is toggled.
 *
 * The live phases of the underlying job ('sending' | 'generating' | 'image')
 * are surfaced through the onPhase callback so the UI can show them as the
 * label of the generating card.
 */

/** Built-in image model exposed in the model selector. */
export const SD_MODEL_ID = 'stable-diffusion-xl';
export const SD_MODEL_NAME = 'Meta AI Imagine';

export const SD_MODELS = [
  { id: SD_MODEL_ID, name: SD_MODEL_NAME },
];

export function normalizeSdSize(size: string | null | undefined): string {
  // Kept for API compatibility — the Nelthai instant mode picks its own
  // output size; the parameter is accepted but no longer constrained.
  return size && /^\d+x\d+$/.test(size) ? size : '1024x1024';
}

export type GeneratedImage = { bytes: Buffer; contentType: string };

export interface GenerateImageOptions {
  /** Live job phases — displayed on the generating card. */
  onPhase?: (phase: NelthaiPhase) => void;
  /** Fired when an attempt failed and another one starts (UI transparency). */
  onRetry?: (attemptIndex: number, totalAttempts: number) => void;
  /**
   * Source images for image→image generation. When present (and non-empty)
   * the multipart image-to-image endpoint is used instead of text→image.
   */
  sourceImages?: NelthaiImageSource[];
}

/**
 * Transient-failure tolerance for the Nelthai engine (observed live on the
 * gateway): the upstream sometimes rejects a perfectly fine job with a bare
 * status 'error' and NO detail whatsoever. Two distinct failure modes:
 *
 *   • transient blips — the SAME prompt fails once then succeeds minutes
 *     later (verified: « voiture rouge »);
 *   • short/trivial prompts — « chat », « maison », a single letter… are
 *     rejected deterministically, while the same prompt enriched with a
 *     light descriptive suffix goes through (verified live);
 *   • genuinely filtered subjects (« logo », explicit content) fail every
 *     time — only a clear error message helps there.
 *
 * ChatGPT-like behavior: retry invisibly. The chain runs up to three
 * attempts — the user's prompt, the user's prompt again (transient blips),
 * then the enriched prompt (short-prompt rejections). There is NO global
 * time budget anymore: each attempt runs its job to completion however
 * long the upstream takes — a generation is never interrupted by a clock.
 * Every attempt restarts the live phases so the generating card keeps
 * moving. (The Vercel invocation window is the only physical ceiling,
 * route maxDuration 300s — nothing else cuts a running generation.)
 */
const PROMPT_ENRICHMENT = ' — image détaillée et de haute qualité';

// ---------------------------------------------------------------------------
// v0.14.10 — honest failure diagnosis. The reported production bug taught the
// lesson: a turn that fails because its SOURCE IMAGE never reached the engine
// used to surface « le service a probablement refusé ce sujet (politique de
// contenu)… » — a diagnosis that pointed the user at their PROMPT while the
// real cause was the absent attachment. The engine failure surface is small
// and observable, so classify it instead of guessing:
//
//   • SOURCE      — every attempt ran the multipart image→image endpoint and
//                   died at SUBMIT: the endpoint refused the attachment
//                   itself (bad format, unreadable bytes, oversized file),
//                   not the prompt and not the service → "réattachez une
//                   image valide";
//   • UNAVAILABLE — connectivity symptoms dominate (5xx at submit, dead
//                   polls, timeouts, download-only failures): the gateway
//                   never delivered → "réessayez dans quelques instants",
//                   NEVER a content-policy claim;
//   • REFUSED     — jobs were accepted and RAN, the engine terminally
//                   rejected them: filtered subject or too-short prompt →
//                   the rephrasing advice (« un chat orange qui dort sur un
//                   canapé » plutôt que « chat »).
// ---------------------------------------------------------------------------

/** Where a single attempt died — maps to the diagnosis buckets above. */
type AttemptStage = 'submit' | 'job' | 'download';

/** One recorded failure: its stage, raw detail and the endpoint family used. */
type AttemptFailure = { stage: AttemptStage; detail: string; withSources: boolean };

function stageOf(e: unknown): AttemptStage {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  // The multipart endpoint refused the request before any job existed, and
  // the "requires at least one image" guard (defensive — sources are filtered
  // upstream) is the same family: the attachment, not the service.
  if (msg.startsWith('Nelthai submit failed') || msg.startsWith('Image-to-image requires')) return 'submit';
  if (
    msg.startsWith('Failed to download') ||
    msg.includes('returned an empty image') ||
    msg.startsWith('The image service produced no downloadable image')
  ) {
    return 'download';
  }
  // Everything else is a job-stage outcome: terminal 'error' status (engine
  // refusal) or persistent poll/timeout failures (connectivity) — the
  // diagnosis splits them on the raw detail below.
  return 'job';
}

/** True when the raw detail smells like a connectivity problem, not a refusal. */
function isConnectivitySymptom(detail: string): boolean {
  return (
    /HTTP\s5\d\d/i.test(detail) || // gateway 5xx at submit
    /Nelthai poll failed/i.test(detail) || // job snapshot unreachable
    /timed out|timeout/i.test(detail) ||
    /\b(fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|network|socket hang up)\b/i.test(detail) ||
    /no job_id in response/i.test(detail) // gateway alive but broken
  );
}

/** Classified end-failure → the French, actionable user-facing message. */
function diagnoseImageFailure(failures: AttemptFailure[]): { kind: 'source' | 'unavailable' | 'refused'; message: string } {
  // SOURCE — the multipart endpoint rejected the attachment itself on every
  // attempt: the prompt never even reached the engine.
  if (failures.length && failures.every((f) => f.withSources && f.stage === 'submit') && !failures.some((f) => isConnectivitySymptom(f.detail))) {
    const detail = failures[failures.length - 1].detail.replace(/^Nelthai submit failed:\s*/i, '');
    return {
      kind: 'source',
      message:
        `Votre image source n’a pas pu être transmise au service d’images` +
        (detail ? ` (${detail})` : '') +
        `. Vérifiez qu’il s’agit d’une image valide (PNG, JPG ou WEBP), puis réessayez en la réattachant à votre message.`,
    };
  }

  // UNAVAILABLE — the gateway never accepted or never delivered the job:
  // no subject was refused, retrying later is the ONLY useful advice.
  if (failures.some((f) => isConnectivitySymptom(f.detail)) || failures.every((f) => f.stage === 'download')) {
    return {
      kind: 'unavailable',
      message:
        'Le service d’images est momentanément indisponible ou ne répond plus — aucun sujet n’a été refusé. Réessayez simplement dans quelques instants.',
    };
  }

  // REFUSED — jobs ran and the engine terminally rejected them: filtered
  // subject or too-short prompt. The rephrasing advice, WITHOUT the
  // misleading « ou momentanément indisponible » hedge (that bucket got its
  // own diagnosis above).
  return {
    kind: 'refused',
    message:
      'La génération d’image a échoué après plusieurs tentatives : le service a probablement refusé ce sujet (politique de contenu) ou la description est trop courte. Essayez une description un peu plus détaillée — par exemple « un chat orange qui dort sur un canapé » plutôt que « chat » — puis relancez.',
  };
}

/**
 * Generate an image with the built-in Nelthai engine → raw image bytes.
 *
 * Runs the async job to completion (polling every 1.5s, NO time limit),
 * retries on the transient failure modes above, and downloads the first
 * produced image before its CDN URL expires.
 */
export async function generateSdImage(
  prompt: string,
  _size: string | null | undefined = null,
  options: GenerateImageOptions = {}
): Promise<GeneratedImage> {
  const [image] = await generateSdImages(prompt, 1, options);
  return image;
}

/**
 * Generate up to `count` images from ONE Nelthai job → raw image bytes.
 *
 * The studio V3/GIF path folds the requested count INTO the prompt (the
 * caller appends a count directive such as "3 IMAGES") so a SINGLE gateway
 * request produces every variation at once (a job's image_urls[] can hold
 * several URLs) instead of N back-to-back one-image requests.
 *
 * Same transient-failure tolerance as generateSdImage (see above): the
 * chain retries the job, then the enriched prompt. Returns every image
 * that could be downloaded (1..count) — possibly FEWER than requested
 * when the engine produced fewer; callers decide how to cover the gap.
 */
export async function generateSdImages(
  prompt: string,
  count: number,
  options: GenerateImageOptions = {}
): Promise<GeneratedImage[]> {
  if (!prompt || !prompt.trim()) {
    throw new Error('Prompt is required for image generation');
  }
  const wanted = Math.max(1, Math.min(Math.round(count) || 1, 8));

  const sources = (options.sourceImages ?? []).filter((s) =>
    s && ((s.kind === 'url' && /^https?:\/\//i.test(s.url)) || (s.kind === 'bytes' && s.bytes?.length))
  );

  const original = prompt.trim();
  const attempts: string[] =
    original.endsWith(PROMPT_ENRICHMENT) || original.length + PROMPT_ENRICHMENT.length > 4000
      ? [original]
      : [original, original, `${original}${PROMPT_ENRICHMENT}`];

  let lastFailure: unknown = null;
  // v0.14.10 — every failure is recorded with its stage and endpoint family
  // so the final error names the REAL cause (source image / service down /
  // refused subject) instead of the one-size-fits-all policy guess.
  const failures: AttemptFailure[] = [];

  for (let attempt = 0; attempt < attempts.length; attempt++) {
    try {
      // Live label reset: the card shows the job starting over instead of
      // freezing on the failed attempt's last phase.
      options.onPhase?.('sending');
      const jobId = sources.length
        ? await submitNelthaiImageToImage(attempts[attempt], sources)
        : await submitNelthaiTextToImage(attempts[attempt]);
      const urls = await waitForNelthaiImages(jobId, {
        onPhase: (phase) => options.onPhase?.(phase),
        // No timeoutMs: poll until the job completes, however long it runs.
      });

      // The CDN URLs are short-lived — a download blip retries the whole job
      // (regenerating is ~20s, far better than surfacing a download error).
      // Take the first `wanted` downloadable images; extra URLs are ignored.
      const images: GeneratedImage[] = [];
      let lastErr: unknown = new Error('The image service produced no downloadable image');
      for (const url of urls) {
        if (images.length >= wanted) break;
        try {
          images.push(await downloadNelthaiImage(url));
        } catch (e) {
          lastErr = e;
        }
      }
      if (images.length) return images;
      lastFailure = lastErr;
      failures.push({
        stage: stageOf(lastErr),
        detail: lastErr instanceof Error ? lastErr.message : String(lastErr),
        withSources: sources.length > 0,
      });
    } catch (e) {
      lastFailure = e;
      failures.push({
        stage: stageOf(e),
        detail: e instanceof Error ? e.message : String(e),
        withSources: sources.length > 0,
      });
    }

    if (attempt < attempts.length - 1) {
      const retryingIndex = attempt + 1;
      console.warn(
        `[image-generation] attempt ${attempt + 1}/${attempts.length} failed` +
          ` (${lastFailure instanceof Error ? lastFailure.message : String(lastFailure)})` +
          (attempts[retryingIndex] !== attempts[attempt]
            ? ' — retrying with an enriched prompt'
            : ' — retrying the same prompt')
      );
      try {
        options.onRetry?.(retryingIndex, attempts.length);
      } catch {
        /* UI callback must never break the retry chain */
      }
    }
  }

  // Every attempt failed: the diagnosis (v0.14.10) names the real cause —
  // source image / service down / refused subject — instead of the blanket
  // content-policy guess that used to mislead (the reported bug).
  const diagnosis = diagnoseImageFailure(
    failures.length ? failures : [{ stage: 'job', detail: String(lastFailure), withSources: sources.length > 0 }]
  );
  console.error(
    `[image-generation] all attempts failed — diagnosis: ${diagnosis.kind}` +
      (failures.length ? ` (${failures.map((f) => `${f.stage}: ${f.detail.slice(0, 120)}`).join(' | ')})` : '')
  );
  throw new Error(diagnosis.message);
}

function extensionFor(contentType: string): string {
  if (contentType === 'image/jpeg') return '.jpg';
  if (contentType === 'image/webp') return '.webp';
  return '.png';
}

export type SavedImageFile = {
  id: string;
  url: string;
  name: string;
  type: string;
  content_type: string;
};

/** Generate + persist through the files upload pipeline (Python upload_image parity). */
export async function generateAndSaveImage(
  user: ApiUser,
  prompt: string,
  size: string | null | undefined = null,
  metadata: Record<string, any> = {},
  options: GenerateImageOptions = {}
): Promise<SavedImageFile> {
  const { bytes, contentType } = await generateSdImage(prompt, size, options);
  const { uploadFileHandler } = await import('@/server/routers/files');
  const fileItem = await uploadFileHandler(
    user,
    {
      bytes,
      filename: `generated-image-${Date.now()}${extensionFor(contentType)}`,
      contentType,
    },
    { model: SD_MODEL_ID, source: 'image_generation', ...metadata },
    false
  );
  const id = fileItem?.id;
  if (!id) {
    throw new Error('Failed to save the generated image');
  }
  const meta = (fileItem?.meta ?? {}) as Record<string, any>;
  return {
    id,
    url: `/api/v1/files/${id}/content`,
    name: meta.name ?? fileItem?.filename ?? 'generated-image',
    type: 'image',
    content_type: meta.content_type ?? contentType,
  };
}

// ---------------------------------------------------------------------------
// Source image resolution (chat attachments / edit-route inputs → bytes)
// ---------------------------------------------------------------------------

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

/** A file reference as sent by the frontend (id, url, data URL or http URL). */
export type FileRefInput = { id?: string; url?: string; type?: string; name?: string } | string;

async function fileBytesFromFileRow(fileId: string): Promise<NelthaiImageSource | null> {
  const row = await db.file.findUnique({ where: { id: fileId } });
  if (!row) return null;
  const parsed = row.data ? JSON.parse(row.data) : {};
  const b64 = parsed.content_base64;
  if (!b64) return null;
  const meta = row.meta ? JSON.parse(row.meta) : {};
  const contentType = meta.content_type ?? 'image/png';
  return {
    kind: 'bytes',
    bytes: Buffer.from(b64, 'base64'),
    filename: row.filename ?? `input${extensionFor(contentType)}`,
    contentType,
  };
}

/**
 * Resolve image references (file ids, /api/v1/files URLs, data: URLs, remote
 * http(s) URLs) into Nelthai image sources — the multipart `file` parts for
 * local content, `image_url` fields for remote URLs.
 */
export async function resolveImageSources(
  refs: FileRefInput[]
): Promise<NelthaiImageSource[]> {
  const out: NelthaiImageSource[] = [];
  for (const ref of refs ?? []) {
    if (!ref) continue;
    const value = typeof ref === 'string' ? ref : ref.url || ref.id || '';
    if (!value) continue;
    const type = typeof ref === 'object' && ref.type ? String(ref.type) : '';
    const name = typeof ref === 'object' && ref.name ? String(ref.name) : '';

    if (value.startsWith('data:image')) {
      const [header, encoded] = value.split(',', 2);
      const contentType = header.split(';')[0].replace(/^data:/, '') || 'image/png';
      out.push({
        kind: 'bytes',
        bytes: Buffer.from(encoded, 'base64'),
        filename: name || `input${extensionFor(contentType)}`,
        contentType,
      });
      continue;
    }
    if (/^https?:\/\//i.test(value)) {
      // Remote URL: an explicit non-image type excludes it, otherwise the
      // extension (or an 'image' type) decides.
      if (type && type !== 'image' && !IMAGE_EXT.test(value)) continue;
      out.push({ kind: 'url', url: value });
      continue;
    }
    // Local file references (bare ids or /api/v1/files URLs): the frontend
    // labels every chat attachment 'file', so the STORED content type is the
    // source of truth — resolve the row and let its meta decide whether the
    // attachment joins the image-to-image job (a PDF stays out, a PNG joins).
    const fileId = value.includes('/api/v1/files')
      ? value.split('/api/v1/files/')[1].split('/content')[0]
      : value;
    if (!fileId) continue;
    try {
      const source = await fileBytesFromFileRow(fileId);
      if (!source) continue;
      const isImage = /^image\//i.test(source.contentType);
      if (isImage || type === 'image') out.push(source);
    } catch {
      /* unreadable file row — skip */
    }
  }
  return out;
}

export { normalizePhase };
export type { NelthaiPhase, NelthaiImageSource };
