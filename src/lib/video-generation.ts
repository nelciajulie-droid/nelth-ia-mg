import type { ApiUser } from '@/lib/auth';
import {
  vibesGenerateVideo,
  vibesAnimateVideo,
  vibesUploadImage,
  vibesPollBatch,
  downloadVibesVideo,
  type VibesAspectRatio,
  type VibesResolution,
} from '@/lib/imagine/vibes';

/**
 * Built-in video generation engine — Nelth vibes gateway (nelcia.space-z.ai).
 *
 * BOTH directions, mirroring image-generation.ts:
 *
 *   • text→video  — POST /api/vibes/videos/generate → batchId;
 *   • image→video — upload the source image bytes into the vibes media
 *                   store (POST /api/vibes/upload/media → mediaEntId, the
 *                   animate endpoint resolves source_image against that
 *                   store — a bare URL is rejected with MEDIA_GONE), then
 *                   POST /api/vibes/videos/animate → batchId. The user's
 *                   text becomes the MOTION prompt ("la caméra zoome
 *                   lentement…");
 *   • poll     — POST /api/vibes/batches/{id}/poll?timeout=5 every ~4s until
 *                isComplete (a fast submit blip that left no server-side job
 *                retries at once — a quick 502 costs nothing);
 *   • download — grab the MP4 bytes before the CDN URL expires;
 *   • persist  — through the files upload pipeline so the chat message
 *                carries a durable /api/v1/files/{id}/content URL.
 *
 * Live phases ('sending' | 'rendering' | 'finalizing') are surfaced through
 * onPhase so the UI can label the generating card, exactly like images.
 */

export type VideoPhase = 'sending' | 'rendering' | 'finalizing';

/** A source image to animate (image→video), as raw bytes. */
export type VideoSourceImage = {
  bytes: Buffer;
  contentType?: string;
  filename?: string;
};

export interface GenerateVideoOptions {
  /** Live phases — displayed on the generating card. */
  onPhase?: (phase: VideoPhase) => void;
  /** Fired when a submission failed and another one starts. */
  onRetry?: (attemptIndex: number, totalAttempts: number) => void;
  /** Target aspect ratio (default 16:9, text→video only). */
  aspectRatio?: VibesAspectRatio;
  /** Target resolution (default 480p — observed ~35-60s at 480p). */
  resolution?: VibesResolution;
  /** Source image → image→video (animate) instead of text→video. */
  sourceImage?: VideoSourceImage;
}

export type GeneratedVideo = { bytes: Buffer; contentType: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Aspect-ratio / resolution hints parsed from the user's phrasing — the
 * user asks naturally ("en vertical pour un reel", "en HD") and the format
 * follows. 16:9 + 480p by default (observed ~35-60s at 480p).
 */
export function detectVideoFormat(text: string): {
  aspectRatio: VibesAspectRatio;
  resolution: VibesResolution;
} {
  const t = text || '';
  const aspectRatio: VibesAspectRatio = /\b(vertical|verticale|portrait|story|stories|reels?|tiktok|shorts?|9:16|16:9\s*invers[ée]?)\b/i.test(t)
    ? '9:16'
    : /\b(carr[ée]e?|square|1:1)\b/i.test(t)
      ? '1:1'
      : '16:9';
  const resolution: VibesResolution = /\b(hd|720p|haute\s+r[ée]solution|high\s*(?:quality|res)|hq)\b/i.test(t)
    ? '720p'
    : '480p';
  return { aspectRatio, resolution };
}

/**
 * Global budget keeps the whole flow inside the serverless budget (Vercel
 * maxDuration 300s): ~215s of submit+poll+download, then persistence.
 */
const RETRY_GLOBAL_DEADLINE_MS = 215_000;
/** A submit that fails fast (<20s) left no server-side job → retry at once. */
const FAST_SUBMIT_FAIL_MS = 20_000;
const MAX_SUBMIT_ATTEMPTS = 3;
/** How long a single batch may take to complete before the turn fails. */
const POLL_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 4_000;
/** Consecutive poll failures tolerated before giving up on a batch. */
const MAX_POLL_BLIPS = 4;

/** Collect the playable video URLs of a batch snapshot. */
function videoUrlsOf(batch: { content?: VibesBatchContentLike[] }): string[] {
  const urls = (batch.content ?? [])
    .map((c) => (c && typeof c.videoUrl === 'string' ? c.videoUrl : null))
    .filter((u): u is string => /^https?:\/\//i.test(u));
  return [...new Set(urls)];
}

type VibesBatchContentLike = { videoUrl?: unknown };

/**
 * Poll a video batch to completion → the generated video URLs.
 * Throws on batch error, poll exhaustion or timeout.
 */
async function waitForVibesVideo(batchId: string): Promise<string[]> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let blips = 0;
  let lastError: unknown = null;

  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(
        `Video generation timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)}s` +
          (lastError instanceof Error ? ` (last poll error: ${lastError.message})` : '')
      );
    }
    try {
      const batch = await vibesPollBatch(batchId);
      blips = 0;

      if (batch.hasError === true) {
        throw new Error(
          `Video generation failed: ${typeof batch.error === 'string' && batch.error ? batch.error : 'the batch ended in error'}`
        );
      }

      const urls = videoUrlsOf(batch);
      // The batch flips isComplete only after the MP4 is fully rendered —
      // videoUrl may appear earlier (while isLoading) but the bytes are only
      // final then. Wait for the terminal state, EXCEPT when the URL has
      // been stable across two consecutive polls (belt and braces for
      // batches whose isComplete never flips).
      if (batch.isComplete === true && urls.length) return urls;

      if (batch.isComplete === true && !urls.length) {
        throw new Error('Video generation failed: the batch completed without a video');
      }
    } catch (e) {
      // A terminal outcome parsed above must propagate immediately.
      if (e instanceof Error && e.message.startsWith('Video generation')) throw e;
      lastError = e;
      if (++blips >= MAX_POLL_BLIPS) {
        throw new Error(
          `Video generation failed: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Image→video submission: upload the source bytes into the vibes media store
 * (a mediaEntId is MANDATORY — the animate endpoint resolves source_image
 * against that store, a bare URL is rejected with MEDIA_GONE), then start the
 * animate batch. The user's prompt rides along as the motion directive.
 */
async function submitAnimateJob(motionPrompt: string, source: VideoSourceImage): Promise<string> {
  const uploaded = await vibesUploadImage({
    bytes: source.bytes,
    filename: source.filename || 'input.png',
    contentType: source.contentType || 'image/png',
  });
  const motion = motionPrompt.trim();
  const { batchId } = await vibesAnimateVideo({
    source: {
      mediaEntId: uploaded.mediaEntId,
      imageUrl: uploaded.imageUrl,
      // A default motion keeps the job well-formed when the user only sent
      // the image ("anime ça" with no directive).
      prompt: motion || 'Gentle cinematic motion, subtle camera movement',
    },
    motion: motion || undefined,
  });
  return batchId;
}

/**
 * Generate a video with the vibes engine → raw MP4 bytes.
 *
 * TWO directions: with `options.sourceImage` the chain animates that image
 * (upload → animate, the prompt acting as the MOTION directive); otherwise
 * it is a plain text→video generation.
 *
 * Submission is retried when it fails FAST (a quick 502 means no job was
 * created server-side); a batch that already runs is never re-rolled, only
 * its polling continues until the global deadline.
 */
export async function generateVideo(
  prompt: string,
  options: GenerateVideoOptions = {}
): Promise<GeneratedVideo> {
  if (!prompt || !prompt.trim()) {
    throw new Error('Prompt is required for video generation');
  }

  const deadline = Date.now() + RETRY_GLOBAL_DEADLINE_MS;
  let lastFailure: unknown = null;

  for (let attempt = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
    // Only the SUBMIT is retried, and only on fast failures — a slow failure
    // or a batch already accepted leaves the retry loop (the poll phase
    // handles its own transient blips).
    if (attempt > 0 && Date.now() > deadline) break;

    const submitStartedAt = Date.now();
    try {
      options.onPhase?.('sending');
      const batchId = options.sourceImage
        ? await submitAnimateJob(prompt, options.sourceImage)
        : (
            await vibesGenerateVideo({
              prompt: prompt.trim(),
              aspectRatio: options.aspectRatio,
              resolution: options.resolution,
              variations: 1,
            })
          ).batchId;

      options.onPhase?.('rendering');
      const urls = await waitForVibesVideo(batchId);

      options.onPhase?.('finalizing');
      let lastErr: unknown = new Error('The video service produced no downloadable video');
      for (const url of urls) {
        try {
          return await downloadVibesVideo(url);
        } catch (e) {
          lastErr = e;
        }
      }
      lastFailure = lastErr;
    } catch (e) {
      lastFailure = e;
      // Poll-phase terminal failures (batch error/timeout) are NOT retried —
      // the subject was likely refused; only fast submit blips restart.
      if (e instanceof Error && e.message.startsWith('Video generation')) {
        console.error('[video-generation] batch failed:', e.message);
        break;
      }
      const fast = Date.now() - submitStartedAt < FAST_SUBMIT_FAIL_MS;
      if (!fast) {
        console.error('[video-generation] submit failed (slow — no retry):', e);
        break;
      }
      console.warn(`[video-generation] fast submit blip (attempt ${attempt + 1}) — retrying`);
      if (attempt < MAX_SUBMIT_ATTEMPTS - 1) {
        try {
          options.onRetry?.(attempt + 1, MAX_SUBMIT_ATTEMPTS);
        } catch {
          /* UI callback must never break the retry chain */
        }
      }
    }
  }
  console.error(
    '[video-generation] all attempts failed:',
    lastFailure instanceof Error ? lastFailure.message : String(lastFailure)
  );
  throw new Error(
    'La génération de vidéo a échoué après plusieurs tentatives. Le service de vidéos est probablement momentanément indisponible ou a refusé ce sujet. Essayez de reformuler votre demande (décrivez la scène, le mouvement, le style) puis relancez.'
  );
}

// ---------------------------------------------------------------------------
// Persistence through the files upload pipeline
// ---------------------------------------------------------------------------

export type SavedVideoFile = {
  id: string;
  url: string;
  name: string;
  type: string;
  content_type: string;
  /** Byte size — surfaced on the message file card (the compiled frontend shows it). */
  size: number;
};

/** Generate + persist through the files upload pipeline (image parity). */
export async function generateAndSaveVideo(
  user: ApiUser,
  prompt: string,
  metadata: Record<string, any> = {},
  options: GenerateVideoOptions = {}
): Promise<SavedVideoFile> {
  const { bytes, contentType } = await generateVideo(prompt, options);
  const { uploadFileHandler } = await import('@/server/routers/files');
  const fileItem = await uploadFileHandler(
    user,
    {
      bytes,
      filename: `generated-video-${Date.now()}.mp4`,
      contentType: contentType.startsWith('video/') ? contentType : 'video/mp4',
    },
    { model: 'video-generation', source: 'video_generation', ...metadata },
    false
  );
  const id = fileItem?.id;
  if (!id) {
    throw new Error('Failed to save the generated video');
  }
  const meta = (fileItem?.meta ?? {}) as Record<string, any>;
  return {
    id,
    url: `/api/v1/files/${id}/content`,
    name: meta.name ?? fileItem?.filename ?? 'generated-video.mp4',
    // 'video' — the compiled message grid maps only ["image","file"], so
    // nothing renders natively (loader.js owns the whole video display).
    type: 'video',
    content_type: meta.content_type ?? 'video/mp4',
    size: bytes.length,
  };
}
