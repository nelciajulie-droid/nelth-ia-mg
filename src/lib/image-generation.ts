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
 * status 'error' and NO detail whatsoever — the raw word that used to reach
 * users as "Image generation failed: error". Two distinct failure modes:
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
 * then the enriched prompt (short-prompt rejections) — under a global
 * deadline that keeps the whole flow inside the serverless budget (Vercel
 * maxDuration 300s: ~220s of attempts + download + persist). Every attempt
 * restarts the live phases so the generating card keeps moving.
 */
const PROMPT_ENRICHMENT = ' — image détaillée et de haute qualité';
const RETRY_GLOBAL_DEADLINE_MS = 220_000;
const ATTEMPT_POLL_TIMEOUT_MS = 90_000;
const RETRY_MIN_REMAINING_MS = 15_000;

/**
 * Generate an image with the built-in Nelthai engine → raw image bytes.
 *
 * Runs the async job to completion (polling every 1.5s), retries on the
 * transient failure modes above, and downloads the first produced image
 * before its CDN URL expires.
 */
export async function generateSdImage(
  prompt: string,
  _size: string | null | undefined = null,
  options: GenerateImageOptions = {}
): Promise<GeneratedImage> {
  if (!prompt || !prompt.trim()) {
    throw new Error('Prompt is required for image generation');
  }

  const sources = (options.sourceImages ?? []).filter((s) =>
    s && ((s.kind === 'url' && /^https?:\/\//i.test(s.url)) || (s.kind === 'bytes' && s.bytes?.length))
  );

  const original = prompt.trim();
  const attempts: string[] =
    original.endsWith(PROMPT_ENRICHMENT) || original.length + PROMPT_ENRICHMENT.length > 4000
      ? [original]
      : [original, original, `${original}${PROMPT_ENRICHMENT}`];

  const deadline = Date.now() + RETRY_GLOBAL_DEADLINE_MS;
  let lastFailure: unknown = null;

  for (let attempt = 0; attempt < attempts.length; attempt++) {
    const remaining = deadline - Date.now();
    if (attempt > 0 && remaining < RETRY_MIN_REMAINING_MS) {
      console.warn('[image-generation] retry budget exhausted — surfacing the failure');
      break;
    }

    try {
      // Live label reset: the card shows the job starting over instead of
      // freezing on the failed attempt's last phase.
      options.onPhase?.('sending');
      const jobId = sources.length
        ? await submitNelthaiImageToImage(attempts[attempt], sources)
        : await submitNelthaiTextToImage(attempts[attempt]);
      const urls = await waitForNelthaiImages(jobId, {
        onPhase: (phase) => options.onPhase?.(phase),
        timeoutMs: Math.max(RETRY_MIN_REMAINING_MS, Math.min(ATTEMPT_POLL_TIMEOUT_MS, remaining)),
      });

      // The CDN URLs are short-lived — a download blip retries the whole job
      // (regenerating is ~20s, far better than surfacing a download error).
      let lastErr: unknown = new Error('The image service produced no downloadable image');
      for (const url of urls) {
        try {
          return await downloadNelthaiImage(url);
        } catch (e) {
          lastErr = e;
        }
      }
      lastFailure = lastErr;
    } catch (e) {
      lastFailure = e;
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

  // Every attempt failed (or the budget ran out): a French, actionable
  // message instead of the gateway's bare "error" word.
  throw new Error(
    'La génération d’image a échoué après plusieurs tentatives. Le service d’images a probablement refusé ce sujet (politique de contenu) ou est momentanément indisponible. Essayez de reformuler votre demande avec un peu plus de détails — par exemple « un chat orange qui dort sur un canapé » plutôt que « chat » — puis relancez.'
  );
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
