import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { db } from '@/lib/db';
import { ERROR_MESSAGES, DEFAULT_USER_PERMISSIONS } from '@/lib/constants';
import { configGet, configSet } from '@/lib/config';
import { hasPermission } from '@/lib/access-control';
import { uploadFileHandler } from './files';

/**
 * Port of open_webui/routers/images.py (v0.12.5) — /api/v1/images/*.
 *
 * Default parity: ENABLE_IMAGE_GENERATION (image_generation.enable) and
 * ENABLE_IMAGE_EDIT (images.edit.enable) default to False → POST /edit
 * returns 403 ERROR_MESSAGES.ACCESS_PROHIBITED.
 *
 * Deviations (documented):
 *   • Built-in 'sd' engine (standalone HTTPS, see src/lib/image-generation.ts):
 *     when IMAGE_GENERATION_ENGINE === 'sd' OR the configured 'openai' engine
 *     has no API key, generation is served by the keyless public Pollinations
 *     endpoint with zero external config (no sandbox SDK).
 *   • ENABLE_IMAGE_GENERATION defaults to true so the built-in engine is
 *     testable out of the box (matches /api/config features surface).
 *   • Only the 'openai' generation/edit engine is proxied; gemini / comfyui /
 *     automatic1111 engines return the Python fall-through (null body).
 *   • get_image_data URL fetching performs a plain fetch (the Python
 *     SSRF-safe session re-validation is approximated by scheme checks).
 */

function err(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

const OPENAI_API_BASE_URL = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

function envJson(key: string, def: unknown): any {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return def;
  try {
    return JSON.parse(raw);
  } catch {
    return def;
  }
}

const IMAGE_AUTO_SIZE_MODELS_REGEX_PATTERN = process.env.IMAGE_AUTO_SIZE_MODELS_REGEX_PATTERN || '^gpt-image';
const IMAGE_URL_RESPONSE_MODELS_REGEX_PATTERN = process.env.IMAGE_URL_RESPONSE_MODELS_REGEX_PATTERN || '^gpt-image';

const INCORRECT_FORMAT = (e = ''): string => `Invalid format. Please use the correct format${e}`;

// IMAGE_CONFIG_KEYS (images.py) — field → {config key, env default}
const IMAGE_CONFIG_KEYS: Record<string, { key: string; env: unknown }> = {
  ENABLE_IMAGE_GENERATION: { key: 'image_generation.enable', env: (process.env.ENABLE_IMAGE_GENERATION ?? 'true').toLowerCase() === 'true' },
  ENABLE_IMAGE_PROMPT_GENERATION: { key: 'image_generation.prompt.enable', env: (process.env.ENABLE_IMAGE_PROMPT_GENERATION ?? 'true').toLowerCase() === 'true' },
  IMAGE_GENERATION_ENGINE: { key: 'image_generation.engine', env: process.env.IMAGE_GENERATION_ENGINE || 'openai' },
  IMAGE_GENERATION_MODEL: { key: 'image_generation.model', env: process.env.IMAGE_GENERATION_MODEL || '' },
  IMAGE_SIZE: { key: 'image_generation.size', env: process.env.IMAGE_SIZE || '512x512' },
  IMAGE_STEPS: { key: 'image_generation.steps', env: process.env.IMAGE_STEPS ? parseInt(process.env.IMAGE_STEPS, 10) : 50 },
  IMAGES_OPENAI_API_BASE_URL: { key: 'image_generation.openai.api_base_url', env: process.env.IMAGES_OPENAI_API_BASE_URL || OPENAI_API_BASE_URL },
  IMAGES_OPENAI_API_KEY: { key: 'image_generation.openai.api_key', env: process.env.IMAGES_OPENAI_API_KEY || OPENAI_API_KEY },
  IMAGES_OPENAI_API_VERSION: { key: 'image_generation.openai.api_version', env: process.env.IMAGES_OPENAI_API_VERSION || '' },
  IMAGES_OPENAI_API_PARAMS: { key: 'image_generation.openai.params', env: envJson('IMAGES_OPENAI_API_PARAMS', {}) },
  AUTOMATIC1111_BASE_URL: { key: 'image_generation.automatic1111.base_url', env: process.env.AUTOMATIC1111_BASE_URL || '' },
  AUTOMATIC1111_API_AUTH: { key: 'image_generation.automatic1111.api_auth', env: process.env.AUTOMATIC1111_API_AUTH || '' },
  AUTOMATIC1111_PARAMS: { key: 'image_generation.automatic1111.api_params', env: envJson('AUTOMATIC1111_PARAMS', {}) },
  COMFYUI_BASE_URL: { key: 'image_generation.comfyui.base_url', env: process.env.COMFYUI_BASE_URL || '' },
  COMFYUI_API_KEY: { key: 'image_generation.comfyui.api_key', env: process.env.COMFYUI_API_KEY || '' },
  COMFYUI_WORKFLOW: { key: 'image_generation.comfyui.workflow', env: process.env.COMFYUI_WORKFLOW || '' },
  COMFYUI_WORKFLOW_NODES: { key: 'image_generation.comfyui.nodes', env: envJson('COMFYUI_WORKFLOW_NODES', []) },
  IMAGES_GEMINI_API_BASE_URL: { key: 'image_generation.gemini.api_base_url', env: process.env.IMAGES_GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta' },
  IMAGES_GEMINI_API_KEY: { key: 'image_generation.gemini.api_key', env: process.env.IMAGES_GEMINI_API_KEY || '' },
  IMAGES_GEMINI_ENDPOINT_METHOD: { key: 'image_generation.gemini.endpoint_method', env: process.env.IMAGES_GEMINI_ENDPOINT_METHOD || '' },
  ENABLE_IMAGE_EDIT: { key: 'images.edit.enable', env: (process.env.ENABLE_IMAGE_EDIT ?? '').toLowerCase() === 'true' },
  IMAGE_EDIT_ENGINE: { key: 'images.edit.engine', env: process.env.IMAGE_EDIT_ENGINE || 'openai' },
  IMAGE_EDIT_MODEL: { key: 'images.edit.model', env: process.env.IMAGE_EDIT_MODEL || '' },
  IMAGE_EDIT_SIZE: { key: 'images.edit.size', env: process.env.IMAGE_EDIT_SIZE || '' },
  IMAGES_EDIT_OPENAI_API_BASE_URL: { key: 'images.edit.openai.api_base_url', env: process.env.IMAGES_EDIT_OPENAI_API_BASE_URL || OPENAI_API_BASE_URL },
  IMAGES_EDIT_OPENAI_API_KEY: { key: 'images.edit.openai.api_key', env: process.env.IMAGES_EDIT_OPENAI_API_KEY || OPENAI_API_KEY },
  IMAGES_EDIT_OPENAI_API_VERSION: { key: 'images.edit.openai.api_version', env: process.env.IMAGES_EDIT_OPENAI_API_VERSION || '' },
  IMAGES_EDIT_GEMINI_API_BASE_URL: { key: 'images.edit.gemini.api_base_url', env: process.env.IMAGES_EDIT_GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta' },
  IMAGES_EDIT_GEMINI_API_KEY: { key: 'images.edit.gemini.api_key', env: process.env.IMAGES_EDIT_GEMINI_API_KEY || '' },
  IMAGES_EDIT_COMFYUI_BASE_URL: { key: 'images.edit.comfyui.base_url', env: process.env.IMAGES_EDIT_COMFYUI_BASE_URL || '' },
  IMAGES_EDIT_COMFYUI_API_KEY: { key: 'images.edit.comfyui.api_key', env: process.env.IMAGES_EDIT_COMFYUI_API_KEY || '' },
  IMAGES_EDIT_COMFYUI_WORKFLOW: { key: 'images.edit.comfyui.workflow', env: process.env.IMAGES_EDIT_COMFYUI_WORKFLOW || '' },
  IMAGES_EDIT_COMFYUI_WORKFLOW_NODES: { key: 'images.edit.comfyui.nodes', env: envJson('IMAGES_EDIT_COMFYUI_WORKFLOW_NODES', []) },
};

type ImageConfig = Record<string, any>;

async function getImageConfig(): Promise<ImageConfig> {
  const config: ImageConfig = {};
  for (const [field, { key, env }] of Object.entries(IMAGE_CONFIG_KEYS)) {
    config[field] = await configGet<unknown>(key, env as never);
  }
  return config;
}

async function getConfigValues(): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  for (const { key } of Object.values(IMAGE_CONFIG_KEYS)) {
    values[key] = await configGet<unknown>(key, undefined as never);
  }
  // Python get_config_values returns {field: value} keyed by FIELD names.
  const out: Record<string, unknown> = {};
  for (const [field, { key }] of Object.entries(IMAGE_CONFIG_KEYS)) {
    out[field] = values[key];
  }
  return out;
}

/** Python get_image_model (openai branch). */
function getImageModel(config: ImageConfig): string {
  return config.IMAGE_GENERATION_MODEL || 'dall-e-2';
}

/** Whether generation should be served by the built-in SD engine (z-ai sdk). */
function isBuiltInSdEngine(config: ImageConfig): boolean {
  if (config.IMAGE_GENERATION_ENGINE === 'sd') return true;
  return (
    (config.IMAGE_GENERATION_ENGINE === 'openai' || config.IMAGE_GENERATION_ENGINE === '') &&
    !config.IMAGES_OPENAI_API_KEY
  );
}

/** Whether EDITS should be served by the built-in Nelthai engine (image→image). */
function isBuiltInSdEditEngine(config: ImageConfig): boolean {
  if (config.IMAGE_EDIT_ENGINE === 'sd') return true;
  return (
    (config.IMAGE_EDIT_ENGINE === 'openai' || config.IMAGE_EDIT_ENGINE === '') &&
    !config.IMAGES_EDIT_OPENAI_API_KEY
  );
}

// ---------------------------------------------------------------------------
// Image data loading (get_image_data port)
// ---------------------------------------------------------------------------

const IMAGE_FILE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/mpo': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

function extensionFor(contentType: string): string {
  const lower = contentType.toLowerCase();
  return IMAGE_FILE_EXTENSIONS[lower] ?? '.png';
}

async function getImageData(
  data: string,
  headers: Record<string, string> | null = null
): Promise<{ bytes: Uint8Array | null; contentType: string | null }> {
  try {
    if (data.startsWith('http://') || data.startsWith('https://')) {
      const res = await fetch(data, {
        headers: headers ?? {},
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return { bytes: null, contentType: null };
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.split('/')[0] === false && contentType.startsWith('image/')) {
        return { bytes: new Uint8Array(await res.arrayBuffer()), contentType };
      }
      return { bytes: null, contentType: null };
    }
    if (data.startsWith('data:')) {
      const [header, encoded] = data.split(',', 2);
      const mimeType = header.split(';')[0].replace(/^data:/, '') || 'image/png';
      return { bytes: new Uint8Array(Buffer.from(encoded, 'base64')), contentType: mimeType };
    }
    if (data.includes(',')) {
      const [header, encoded] = data.split(',', 2);
      const mimeType = header.split(';')[0].replace(/^data:/, '') || 'image/png';
      return { bytes: new Uint8Array(Buffer.from(encoded, 'base64')), contentType: mimeType };
    }
    const decoded = new Uint8Array(Buffer.from(data, 'base64'));
    return { bytes: decoded, contentType: 'image/png' };
  } catch {
    return { bytes: null, contentType: null };
  }
}

/** Python upload_image — saves through the files upload pipeline. */
async function uploadImage(
  user: any,
  bytes: Uint8Array | null,
  contentType: string | null,
  metadata: Record<string, any>
): Promise<{ id: string; url: string; name: string; content_type: string } | null> {
  if (bytes === null || contentType === null) {
    throw new Error('Failed to retrieve image data from the generation backend');
  }
  const fileItem = await uploadFileHandler(
    user,
    {
      bytes: Buffer.from(bytes),
      filename: `generated-image${extensionFor(contentType)}`,
      contentType,
    },
    metadata,
    false
  );
  const id = fileItem?.id;
  if (!id) return null;
  const name = fileItem?.meta?.name ?? fileItem?.filename ?? 'generated-image';
  return {
    id,
    url: `/api/v1/files/${id}/content`,
    name,
    content_type: fileItem?.meta?.content_type ?? contentType,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // ------------------- GET /config (admin) -------------------
  {
    method: 'GET',
    path: 'config',
    auth: 'admin',
    handler: async (ctx) => ctx.json(await getConfigValues()),
  },

  // ------------------- POST /config/update (admin) -------------------
  {
    method: 'POST',
    path: 'config/update',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<Record<string, any>>();

      const imageAutoPattern = new RegExp(IMAGE_AUTO_SIZE_MODELS_REGEX_PATTERN);
      if (form?.IMAGE_SIZE === 'auto' && !imageAutoPattern.test(String(form?.IMAGE_GENERATION_MODEL ?? ''))) {
        err(
          400,
          INCORRECT_FORMAT(
            `  (auto is only allowed with models matching ${IMAGE_AUTO_SIZE_MODELS_REGEX_PATTERN}).`
          )
        );
      }
      const pattern = /^\d+x\d+$/;
      if (!(form?.IMAGE_SIZE === 'auto' || form?.IMAGE_SIZE === '' || pattern.test(String(form?.IMAGE_SIZE ?? '')))) {
        err(400, INCORRECT_FORMAT('  (e.g., 512x512).'));
      }
      if (Number(form?.IMAGE_STEPS ?? 0) < 0) {
        err(400, INCORRECT_FORMAT('  (e.g., 50).'));
      }

      for (const [field, { key }] of Object.entries(IMAGE_CONFIG_KEYS)) {
        if (form && field in form) await configSet(key, form[field]);
      }
      if (form?.COMFYUI_BASE_URL !== undefined) {
        await configSet('image_generation.comfyui.base_url', String(form.COMFYUI_BASE_URL).replace(/\/+$/, ''));
      }
      if (form?.IMAGES_EDIT_COMFYUI_BASE_URL !== undefined) {
        await configSet('images.edit.comfyui.base_url', String(form.IMAGES_EDIT_COMFYUI_BASE_URL).replace(/\/+$/, ''));
      }

      return ctx.json(await getConfigValues());
    },
  },

  // ------------------- POST /verify (admin) -------------------
  {
    method: 'POST',
    path: 'verify',
    auth: 'admin',
    handler: async (ctx) => {
      const form = await ctx.body<Record<string, any>>();
      const url = String(form?.url ?? '').replace(/\/+$/, '');
      const headers: Record<string, string> = {};
      let target = url;
      if (form?.engine === 'automatic1111') {
        target = `${url}/sdapi/v1/options`;
        if (form.key !== null && form.key !== undefined) {
          headers['Authorization'] = `Basic ${Buffer.from(String(form.key)).toString('base64')}`;
        }
      } else if (form?.engine === 'comfyui') {
        target = `${url}/object_info`;
        if (form.key) headers['Authorization'] = `Bearer ${form.key}`;
      } else {
        err(400, 'Unsupported image engine');
      }

      try {
        const res = await fetch(target, { headers, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return ctx.json(true);
      } catch {
        err(400, ERROR_MESSAGES.INVALID_URL);
      }
    },
  },

  // ------------------- GET /models (user) -------------------
  {
    method: 'GET',
    path: 'models',
    auth: 'user',
    handler: async (ctx) => {
      const config = await getImageConfig();
      try {
        if (isBuiltInSdEngine(config)) {
          const { SD_MODELS } = await import('@/lib/image-generation');
          return ctx.json(SD_MODELS);
        }
        if (config.IMAGE_GENERATION_ENGINE === 'openai') {
          return ctx.json([
            { id: 'dall-e-2', name: 'DALL·E 2' },
            { id: 'dall-e-3', name: 'DALL·E 3' },
            { id: 'gpt-image-1', name: 'GPT-IMAGE 1' },
            { id: 'gpt-image-1.5', name: 'GPT-IMAGE 1.5' },
          ]);
        }
        if (config.IMAGE_GENERATION_ENGINE === 'gemini') {
          return ctx.json([{ id: 'imagen-3.0-generate-002', name: 'imagen-3.0 generate-002' }]);
        }
        if (config.IMAGE_GENERATION_ENGINE === 'automatic1111' || config.IMAGE_GENERATION_ENGINE === '') {
          const res = await fetch(
            `${String(config.AUTOMATIC1111_BASE_URL).replace(/\/$/, '')}/sdapi/v1/sd-models`,
            {
              headers: config.AUTOMATIC1111_API_AUTH
                ? { authorization: `Basic ${Buffer.from(String(config.AUTOMATIC1111_API_AUTH)).toString('base64')}` }
                : {},
              signal: AbortSignal.timeout(10_000),
            }
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const models = await res.json();
          return ctx.json(
            (models ?? []).map((m: any) => ({ id: m.title, name: m.model_name }))
          );
        }
        return ctx.json([]);
      } catch (e) {
        err(400, `Failed to retrieve image generation models: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },

  // ------------------- POST /generations (user) -------------------
  {
    method: 'POST',
    path: 'generations',
    auth: 'user',
    handler: async (ctx) => {
      // MODE INVITÉ: image generation locked for guests (ChatGPT parity).
      {
        const { isGuestUser } = await import('@/lib/guests');
        if (isGuestUser(ctx.user)) {
          err(403, 'La génération d’images est réservée aux comptes gratuits. Créez un compte pour l’activer.');
        }
      }
      const config = await getImageConfig();
      if (!config.ENABLE_IMAGE_GENERATION) {
        err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }
      const user = ctx.user!;
      if (user.role !== 'admin') {
        const permissions = await configGet<Record<string, any> | null>(
          'user.permissions',
          DEFAULT_USER_PERMISSIONS as unknown as Record<string, any>
        );
        if (!(await hasPermission(user.id, 'features.image_generation', permissions))) {
          err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
        }
      }

      const form = await ctx.body<Record<string, any>>();
      if (!form?.prompt) err(422, 'Field required (prompt)');

      try {
        if (isBuiltInSdEngine(config)) {
          // Built-in SD engine (z-ai sdk) — zero-config generation.
          const { generateAndSaveImage } = await import('@/lib/image-generation');
          const images: Array<Record<string, any> | null> = [];
          const count = Math.max(1, Math.min(Number(form.n ?? 1) || 1, 4));
          for (let i = 0; i < count; i++) {
            const file = await generateAndSaveImage(ctx.user!, form.prompt, form.size || config.IMAGE_SIZE);
            images.push(file);
          }
          return ctx.json(images);
        }

        if (config.IMAGE_GENERATION_ENGINE === 'openai') {
          const headers: Record<string, string> = {
            authorization: `Bearer ${config.IMAGES_OPENAI_API_KEY}`,
            'content-type': 'application/json',
          };

          const model = getImageModel(config);
          const data: Record<string, any> = {
            model,
            prompt: form.prompt,
            n: form.n ?? 1,
          };
          if (form.size || config.IMAGE_SIZE) {
            data['size'] = form.size || config.IMAGE_SIZE;
          }
          if (!new RegExp(IMAGE_URL_RESPONSE_MODELS_REGEX_PATTERN).test(String(config.IMAGE_GENERATION_MODEL ?? ''))) {
            data['response_format'] = 'b64_json';
          }
          if (config.IMAGES_OPENAI_API_PARAMS) {
            Object.assign(data, config.IMAGES_OPENAI_API_PARAMS);
          }

          let url = `${String(config.IMAGES_OPENAI_API_BASE_URL).replace(/\/$/, '')}/images/generations`;
          if (config.IMAGES_OPENAI_API_VERSION) {
            url += `?api-version=${config.IMAGES_OPENAI_API_VERSION}`;
          }

          const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(data),
            signal: AbortSignal.timeout(120_000),
          });
          if (!res.ok) {
            const detail = await res
              .clone()
              .json()
              .then((b: any) => (b?.error?.message ? `External: ${b.error.message}` : `HTTP ${res.status}`))
              .catch(() => `HTTP ${res.status}`);
            throw new Error(detail);
          }
          const result = await res.json();

          const images: Array<Record<string, any> | null> = [];
          for (const image of result?.data ?? []) {
            let bytes: Uint8Array | null = null;
            let contentType: string | null = null;
            if (image.url) {
              const sameOrigin = String(image.url).startsWith(
                String(config.IMAGES_OPENAI_API_BASE_URL).replace(/\/$/, '')
              );
              const loaded = await getImageData(
                String(image.url),
                sameOrigin ? { authorization: `Bearer ${config.IMAGES_OPENAI_API_KEY}` } : null
              );
              bytes = loaded.bytes;
              contentType = loaded.contentType;
            } else if (image.b64_json) {
              const loaded = await getImageData(String(image.b64_json));
              bytes = loaded.bytes;
              contentType = loaded.contentType;
            }
            const imageFile = await uploadImage(user, bytes, contentType, { ...data });
            images.push(imageFile);
          }
          return ctx.json(images);
        }

        // gemini / comfyui / automatic1111 engines not ported — Python's
        // fall-through returns a null body.
        return ctx.json(null);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, `[ERROR: ${e instanceof Error ? e.message : String(e)}]`);
      }
    },
  },

  // ------------------- POST /edit (user) -------------------
  {
    method: 'POST',
    path: 'edit',
    auth: 'user',
    handler: async (ctx) => {
      // MODE INVITÉ: image editing locked for guests (ChatGPT parity).
      {
        const { isGuestUser } = await import('@/lib/guests');
        if (isGuestUser(ctx.user)) {
          err(403, 'L’édition d’images est réservée aux comptes gratuits. Créez un compte pour l’activer.');
        }
      }
      const config = await getImageConfig();
      if (!config.ENABLE_IMAGE_EDIT) {
        err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
      }
      const user = ctx.user!;
      if (user.role !== 'admin') {
        const permissions = await configGet<Record<string, any> | null>(
          'user.permissions',
          DEFAULT_USER_PERMISSIONS as unknown as Record<string, any>
        );
        if (!(await hasPermission(user.id, 'features.image_generation', permissions))) {
          err(403, ERROR_MESSAGES.ACCESS_PROHIBITED);
        }
      }

      const form = await ctx.body<Record<string, any>>();
      if (!form?.image || !form?.prompt) err(422, 'Field required');

      try {
        // Built-in Nelthai engine — image→image through the multipart
        // metaai endpoint (source images resolved from ids/URLs/data URLs).
        if (isBuiltInSdEditEngine(config)) {
          const { generateAndSaveImage, resolveImageSources } = await import('@/lib/image-generation');
          const imagesInput = Array.isArray(form.image) ? form.image : [form.image];
          const sourceImages = await resolveImageSources(imagesInput);
          if (!sourceImages.length) {
            throw new Error('Failed to load the source image(s) for the edit');
          }
          const file = await generateAndSaveImage(
            user,
            form.prompt,
            form.size || config.IMAGE_EDIT_SIZE || null,
            { model: 'stable-diffusion-xl', source: 'image_edit' },
            { sourceImages }
          );
          return ctx.json([file]);
        }

        if (config.IMAGE_EDIT_ENGINE === 'openai') {
          const headers: Record<string, string> = {
            authorization: `Bearer ${config.IMAGES_EDIT_OPENAI_API_KEY}`,
          };

          const size =
            (config.IMAGE_EDIT_SIZE && String(config.IMAGE_EDIT_SIZE).includes('x')) ||
            (form.size && String(form.size).includes('x'))
              ? form.size || config.IMAGE_EDIT_SIZE
              : null;
          const model = form.model ?? config.IMAGE_EDIT_MODEL ?? '';

          const data: Record<string, any> = { model, prompt: form.prompt };
          if (form.n) data['n'] = form.n;
          if (size) data['size'] = size;
          if (form.background) data['background'] = form.background;
          if (!new RegExp(IMAGE_URL_RESPONSE_MODELS_REGEX_PATTERN).test(String(config.IMAGE_EDIT_MODEL ?? ''))) {
            data['response_format'] = 'b64_json';
          }

          // Load image(s) — URLs are fetched, data URLs passthrough.
          const load = async (img: any): Promise<string> => {
            const value = String(img);
            if (value.startsWith('data:')) return value;
            if (value.startsWith('http://') || value.startsWith('https://')) {
              const res = await fetch(value, { signal: AbortSignal.timeout(30_000) });
              if (!res.ok) throw new Error(`Failed to load image: HTTP ${res.status}`);
              const b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
              return `data:${res.headers.get('content-type') ?? 'image/png'};base64,${b64}`;
            }
            // /api/v1/files/{id}[/content] or bare file id
            const fileId = value.includes('/api/v1/files')
              ? value.split('/api/v1/files/')[1].split('/content')[0]
              : value;
            const row = await db.file.findUnique({ where: { id: fileId } });
            if (!row) throw new Error('Failed to load image');
            const parsed = row.data ? JSON.parse(row.data) : {};
            const b64 = parsed.content_base64;
            if (!b64) throw new Error('Failed to load image');
            const contentType = row.meta ? (JSON.parse(row.meta).content_type ?? 'image/png') : 'image/png';
            return `data:${contentType};base64,${b64}`;
          };

          const imagesInput = Array.isArray(form.image) ? form.image : [form.image];
          const loaded = await Promise.all(imagesInput.map(load));

          // Build multipart form for /images/edits.
          const fd = new FormData();
          for (const [key, value] of Object.entries(data)) {
            fd.set(key, String(value));
          }
          loaded.forEach((dataUrl, i) => {
            const [header, encoded] = dataUrl.split(',', 2);
            const mime = header.split(';')[0].replace(/^data:/, '') || 'image/png';
            const ext = extensionFor(mime);
            fd.set(Array.isArray(form.image) ? 'image[]' : 'image', new File([Buffer.from(encoded, 'base64')], `${crypto.randomUUID()}${ext}`, { type: mime }), `${crypto.randomUUID()}${ext}`);
            void i;
          });

          let url = `${String(config.IMAGES_EDIT_OPENAI_API_BASE_URL).replace(/\/$/, '')}/images/edits`;
          if (config.IMAGES_EDIT_OPENAI_API_VERSION) {
            url += `?api-version=${config.IMAGES_EDIT_OPENAI_API_VERSION}`;
          }

          const res = await fetch(url, {
            method: 'POST',
            headers,
            body: fd,
            signal: AbortSignal.timeout(120_000),
          });
          if (!res.ok) {
            const detail = await res
              .clone()
              .json()
              .then((b: any) => (b?.error?.message ? `External: ${b.error.message}` : `HTTP ${res.status}`))
              .catch(() => `HTTP ${res.status}`);
            throw new Error(detail);
          }
          const result = await res.json();

          const images: Array<Record<string, any> | null> = [];
          for (const image of result?.data ?? []) {
            let bytes: Uint8Array | null = null;
            let contentType: string | null = null;
            if (image.url) {
              const loaded2 = await getImageData(String(image.url), null);
              bytes = loaded2.bytes;
              contentType = loaded2.contentType;
            } else if (image.b64_json) {
              const loaded2 = await getImageData(String(image.b64_json));
              bytes = loaded2.bytes;
              contentType = loaded2.contentType;
            }
            const imageFile = await uploadImage(user, bytes, contentType, { ...data });
            images.push(imageFile);
          }
          return ctx.json(images);
        }

        return ctx.json(null);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, `[ERROR: ${e instanceof Error ? e.message : String(e)}]`);
      }
    },
  },
];
