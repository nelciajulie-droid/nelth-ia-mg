import type { ApiUser } from '@/lib/auth';

/**
 * Built-in image generation engine — standalone HTTP implementation (no SDK).
 *
 * TS-port of images.py: the Python backend proxies to an external OpenAI /
 * ComfyUI / Automatic1111 endpoint when one is configured. This standalone
 * port ships a zero-config engine backed by the public Pollinations API
 * (https://image.pollinations.ai) — keyless, free, real diffusion models
 * (FLUX / Sana / Turbo). It is used:
 *
 *   - by POST /api/v1/images/generations when the configured engine has no
 *     API key (or when IMAGE_GENERATION_ENGINE === 'sd'),
 *   - by the chat pipeline when the selected model is the built-in
 *     `stable-diffusion-xl` model or the image-generation feature is toggled.
 *
 * No sandbox SDK is involved: the engine talks plain HTTPS and therefore
 * works on any host (local, Docker, bare metal).
 */

const SUPPORTED_SIZES = [
  '1024x1024',
  '768x1344',
  '864x1152',
  '1344x768',
  '1152x864',
  '1440x720',
  '720x1440',
] as const;

/** Built-in SD model exposed in the model selector. */
export const SD_MODEL_ID = 'stable-diffusion-xl';
export const SD_MODEL_NAME = 'Stable Diffusion XL';

export const SD_MODELS = [
  { id: SD_MODEL_ID, name: SD_MODEL_NAME },
  { id: 'stable-diffusion-3.5-large', name: 'Stable Diffusion 3.5 Large' },
  { id: 'stable-diffusion-3.5-medium', name: 'Stable Diffusion 3.5 Medium' },
  { id: 'sd-turbo', name: 'SD Turbo' },
];

export function normalizeSdSize(size: string | null | undefined): string {
  if (size && (SUPPORTED_SIZES as readonly string[]).includes(size)) return size;
  return '1024x1024';
}

/** Pollinations endpoint base (keyless public image generation). */
const POLLINATIONS_BASE = 'https://image.pollinations.ai/prompt';

/** Optional engine override via env (empty → default public endpoint). */
const IMAGE_ENGINE_BASE =
  process.env.IMAGE_GENERATION_ENGINE_BASE_URL?.replace(/\/+$/, '') || POLLINATIONS_BASE;

export type GeneratedImage = { bytes: Buffer; contentType: string };

/** Detect the real image format from magic bytes (engine returns JPEG or PNG). */
function sniffContentType(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    return 'image/webp';
  }
  return 'image/png';
}

/**
 * Generate an image with the built-in engine → raw image bytes.
 *
 * Retries up to 3 times with backoff — the public endpoint occasionally
 * queues requests under load (HTTP 5xx / truncated bodies).
 */
export async function generateSdImage(
  prompt: string,
  size: string | null | undefined = null
): Promise<GeneratedImage> {
  if (!prompt || !prompt.trim()) {
    throw new Error('Prompt is required for image generation');
  }
  const normalized = normalizeSdSize(size);
  const [width, height] = normalized.split('x').map((n) => parseInt(n, 10));

  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    nologo: 'true',
    safe: 'false',
  });
  // No `model` param: the anonymous tier serves the default model only
  // (any other value returns 402 Payment Required).

  const url = `${IMAGE_ENGINE_BASE}/${encodeURIComponent(prompt.trim().slice(0, 1900))}?${params}`;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1500 * attempt)); // backoff 1.5s / 3s
    }
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { accept: 'image/jpeg, image/png, image/webp, */*' },
        signal: AbortSignal.timeout(120_000),
        redirect: 'follow',
      });
      if (!res.ok) {
        lastError = new Error(`Image engine HTTP ${res.status}`);
        continue; // retry
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length < 1024) {
        // Truncated / placeholder body — retry.
        lastError = new Error('Image engine returned a truncated body');
        continue;
      }
      const contentType = sniffContentType(bytes);
      if (contentType === 'image/png' && bytes.length < 4096) {
        // Tiny PNG = error placeholder from the endpoint.
        lastError = new Error('Image engine returned a placeholder');
        continue;
      }
      return { bytes, contentType };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Image generation failed after retries');
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
  metadata: Record<string, any> = {}
): Promise<SavedImageFile> {
  const { bytes, contentType } = await generateSdImage(prompt, size);
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
