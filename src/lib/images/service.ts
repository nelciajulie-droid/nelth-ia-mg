/**
 * Nelth-IA Images — studio service (server-side).
 *
 * Everything the /api/v1/imagine router needs:
 *
 *   • Engine resolution — the SAME engines the chat pipeline already uses
 *     (src/lib/image-generation.ts: built-in Nelthai metaai gateway; the
 *     configured OpenAI Images engine when a key exists). No parallel
 *     provider system is introduced.
 *   • Capabilities — the honest feature map the UI displays (aspect-ratio
 *     mode, qualities, max count…).
 *   • Async generation — rows are created in status 'generating' and the
 *     router schedules the worker with next/server `after()`; the UI polls
 *     /items. NO time limit: a worker heartbeat keeps live rows fresh and
 *     the reaper only fails rows whose worker died (serverless freeze).
 *   • Persistence — bytes through the existing files pipeline (file_id →
 *     /api/v1/files/{id}/content), metadata in the image_item table.
 */

import { db, execUnsafe, IS_SQLITE } from '@/lib/db';
import type { ApiUser } from '@/lib/auth';
import { configGet } from '@/lib/config';
import { DEFAULT_USER_PERMISSIONS } from '@/lib/constants';
import { hasPermission } from '@/lib/access-control';
import { uploadFileHandler } from '@/server/routers/files';
import {
  generateSdImage,
  resolveImageSources,
  type FileRefInput,
  type GeneratedImage,
} from '@/lib/image-generation';
import { imagineStyleById, ratioHint, ratioToOpenAiSize } from '@/lib/images/styles';
import type { ImagineCapabilities, ImagineItem } from '@/lib/images/types';

// ---------------------------------------------------------------------------
// Lazy table bootstrap (serverless: no deploy-time migration step needed).
// ---------------------------------------------------------------------------

let tableEnsured = false;

/**
 * CREATE TABLE IF NOT EXISTS for image_item — dialect-aware (SQLite local /
 * Postgres prod) and exactly matching the Prisma model so the generated
 * client's queries work everywhere without a manual `db push` on Vercel.
 */
export async function ensureImageItemsTable(): Promise<void> {
  if (tableEnsured) return;
  const ddl = IS_SQLITE
    ? [
        `CREATE TABLE IF NOT EXISTS "image_item" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "user_id" TEXT NOT NULL,
          "name" TEXT NULL,
          "prompt" TEXT NULL,
          "file_id" TEXT NULL,
          "provider" TEXT NULL,
          "model" TEXT NULL,
          "status" TEXT NULL,
          "aspect_ratio" TEXT NULL,
          "width" INTEGER NULL,
          "height" INTEGER NULL,
          "favorite" BOOLEAN NOT NULL DEFAULT false,
          "source" TEXT NULL,
          "parent_id" TEXT NULL,
          "meta" TEXT NULL,
          "created_at" INTEGER NULL,
          "updated_at" INTEGER NULL
        )`,
        `CREATE INDEX IF NOT EXISTS "image_item_user_id_idx" ON "image_item"("user_id")`,
        `CREATE INDEX IF NOT EXISTS "image_item_user_id_status_idx" ON "image_item"("user_id","status")`,
        `CREATE INDEX IF NOT EXISTS "image_item_created_at_idx" ON "image_item"("created_at")`,
      ]
    : [
        `CREATE TABLE IF NOT EXISTS "image_item" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "user_id" TEXT NOT NULL,
          "name" TEXT,
          "prompt" TEXT,
          "file_id" TEXT,
          "provider" TEXT,
          "model" TEXT,
          "status" TEXT,
          "aspect_ratio" TEXT,
          "width" INTEGER,
          "height" INTEGER,
          "favorite" BOOLEAN NOT NULL DEFAULT false,
          "source" TEXT,
          "parent_id" TEXT,
          "meta" TEXT,
          "created_at" INTEGER,
          "updated_at" INTEGER
        )`,
        `CREATE INDEX IF NOT EXISTS "image_item_user_id_idx" ON "image_item"("user_id")`,
        `CREATE INDEX IF NOT EXISTS "image_item_user_id_status_idx" ON "image_item"("user_id","status")`,
        `CREATE INDEX IF NOT EXISTS "image_item_created_at_idx" ON "image_item"("created_at")`,
      ];
  for (const statement of ddl) {
    await execUnsafe(statement);
  }
  tableEnsured = true;
}

// ---------------------------------------------------------------------------
// Engine resolution + capabilities
// ---------------------------------------------------------------------------

interface ActiveEngine {
  kind: 'builtin' | 'openai';
  label: string;
  openaiBaseUrl: string;
  openaiKey: string;
  openaiModel: string;
}

async function resolveActiveEngine(): Promise<ActiveEngine> {
  const engine = String(
    (await configGet<unknown>('image_generation.engine', process.env.IMAGE_GENERATION_ENGINE || 'openai')) ?? 'openai'
  );
  const baseUrl = String(
    (await configGet<unknown>(
      'image_generation.openai.api_base_url',
      process.env.IMAGES_OPENAI_API_BASE_URL || process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1'
    )) ?? ''
  ).replace(/\/+$/, '');
  const key = String(
    (await configGet<unknown>(
      'image_generation.openai.api_key',
      process.env.IMAGES_OPENAI_API_KEY || process.env.OPENAI_API_KEY || ''
    )) ?? ''
  );
  const model = String(
    (await configGet<unknown>('image_generation.model', process.env.IMAGE_GENERATION_MODEL || '')) ?? ''
  );
  const builtin = engine === 'sd' || engine === 'sdwebui' || ((engine === 'openai' || engine === '') && !key);
  return {
    kind: builtin ? 'builtin' : 'openai',
    label: builtin ? 'Moteur intégré Nelth' : 'OpenAI Images',
    openaiBaseUrl: baseUrl,
    openaiKey: key,
    openaiModel: model || 'gpt-image-1',
  };
}

export async function getImagineCapabilities(): Promise<ImagineCapabilities> {
  const engine = await resolveActiveEngine();
  const enabled = await configGet<unknown>('image_generation.enable', true);
  if (enabled === false) {
    // Feature flag off — everything honestly unsupported.
    return {
      engine: engine.kind,
      engineLabel: engine.label,
      features: {
        textToImage: false,
        imageToImage: false,
        variations: false,
        editing: false,
        uploads: true,
      },
      aspectRatioMode: 'none',
      aspectRatios: ['1:1'],
      qualities: null,
      maxCount: 1,
    };
  }
  if (engine.kind === 'builtin') {
    return {
      engine: 'builtin',
      engineLabel: engine.label,
      features: { textToImage: true, imageToImage: true, variations: true, editing: true, uploads: true },
      // The Nelthai instant mode picks its own output size — the ratio is
      // folded into the prompt as composition guidance, never faked as a
      // size parameter.
      aspectRatioMode: 'creative-hint',
      aspectRatios: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'],
      qualities: null,
      maxCount: 4,
    };
  }
  return {
    engine: 'openai',
    engineLabel: engine.label,
    features: { textToImage: true, imageToImage: true, variations: true, editing: true, uploads: true },
    aspectRatioMode: 'exact',
    aspectRatios: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'],
    qualities: ['standard', 'hd'],
    maxCount: 4,
  };
}

/** Feature gate shared by generate/edit/variations (chat parity). */
export async function assertStudioPermission(user: ApiUser): Promise<void> {
  const enabled = await configGet<unknown>('image_generation.enable', true);
  if (enabled === false) {
    throw new Error('La génération d’images est désactivée par l’administrateur.');
  }
  if (user.role === 'admin') return;
  const permissions = await configGet<Record<string, unknown> | null>(
    'user.permissions',
    DEFAULT_USER_PERMISSIONS as unknown as Record<string, unknown>
  );
  if (!(await hasPermission(user.id, 'features.image_generation', permissions))) {
    throw new Error('Vous n’avez pas la permission de générer des images.');
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type ImageItemRow = {
  id: string;
  user_id: string;
  name: string | null;
  prompt: string | null;
  file_id: string | null;
  provider: string | null;
  model: string | null;
  status: string | null;
  aspect_ratio: string | null;
  width: number | null;
  height: number | null;
  favorite: boolean;
  source: string | null;
  parent_id: string | null;
  meta: string | null;
  created_at: number | null;
  updated_at: number | null;
};

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rowToItem(row: ImageItemRow): ImagineItem {
  const meta = parseMeta(row.meta);
  const status = (row.status ?? 'failed') as ImagineItem['status'];
  const phase = typeof meta.phase === 'string' ? (meta.phase as ImagineItem['phase']) : null;
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    prompt: row.prompt,
    file_id: row.file_id,
    url: row.file_id ? `/api/v1/files/${row.file_id}/content` : null,
    provider: row.provider,
    model: row.model,
    status,
    phase,
    aspect_ratio: row.aspect_ratio,
    width: row.width,
    height: row.height,
    favorite: !!row.favorite,
    source: (row.source ?? 'generate') as ImagineItem['source'],
    parent_id: row.parent_id,
    meta,
    error: typeof meta.error === 'string' ? (meta.error as string) : null,
    created_at: row.created_at ?? Math.floor(Date.now() / 1000),
    updated_at: row.updated_at ?? Math.floor(Date.now() / 1000),
  };
}

async function getItemRow(id: string): Promise<ImageItemRow | null> {
  await ensureImageItemsTable();
  return (await db.imageItem.findUnique({ where: { id } })) as ImageItemRow | null;
}

async function patchItemRow(
  id: string,
  data: Partial<{ name: string; favorite: boolean; status: string; file_id: string; provider: string; model: string; width: number; height: number; prompt: string; aspect_ratio: string; parent_id: string; source: string; meta: string; updated_at: number }>
): Promise<ImageItemRow | null> {
  await ensureImageItemsTable();
  return (await db.imageItem.update({
    where: { id },
    data: { ...data, updated_at: Math.floor(Date.now() / 1000) },
  })) as ImageItemRow | null;
}

async function setItemMeta(id: string, patch: Record<string, unknown>): Promise<void> {
  const row = await getItemRow(id);
  if (!row) return;
  const meta = { ...parseMeta(row.meta), ...patch };
  await patchItemRow(id, { meta: JSON.stringify(meta) });
}

// ---------------------------------------------------------------------------
// Effective prompt building (documented, honest enrichment)
// ---------------------------------------------------------------------------

export interface GenerationPlan {
  prompt: string;
  style?: string;
  aspectRatio?: string;
  sourceImages?: FileRefInput[];
}

function buildEffectivePrompt(plan: GenerationPlan, ratioMode: 'exact' | 'creative-hint' | 'none'): string {
  const parts: string[] = [plan.prompt.trim()];
  const style = imagineStyleById(plan.style);
  if (style && style.suffix) parts.push(style.suffix.trim());
  if (ratioMode === 'creative-hint' && plan.aspectRatio) {
    const hint = ratioHint(plan.aspectRatio);
    if (hint) parts.push(`(${hint})`);
  }
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Queued item creation + background worker
// ---------------------------------------------------------------------------

interface QueuedItemInput {
  prompt: string;
  style?: string;
  aspectRatio?: string;
  source: ImagineItem['source'];
  parentId?: string | null;
  status?: string;
}

async function createQueuedItem(
  user: ApiUser,
  input: QueuedItemInput
): Promise<ImagineItem> {
  await ensureImageItemsTable();
  const now = Math.floor(Date.now() / 1000);
  const row = (await db.imageItem.create({
    data: {
      id: crypto.randomUUID(),
      user_id: user.id,
      name: null,
      prompt: input.prompt,
      file_id: null,
      provider: null,
      model: null,
      status: input.status ?? 'generating',
      aspect_ratio: input.aspectRatio ?? null,
      width: null,
      height: null,
      favorite: false,
      source: input.source,
      parent_id: input.parentId ?? null,
      meta: JSON.stringify({
        style: input.style ?? null,
        phase: input.status === 'completed' ? null : 'sending',
      }),
      created_at: now,
      updated_at: now,
    },
  })) as ImageItemRow;
  return rowToItem(row);
}

/**
 * Generate + persist one item through the ACTIVE engine.
 *
 * A HEARTBEAT bumps the row's updated_at every 20s while this worker runs —
 * the stale reaper can then NEVER interrupt a live generation (however
 * slow the upstream): it only fires for rows whose worker died
 * (serverless freeze), 30 minutes after the last sign of life.
 */
const HEARTBEAT_MS = 20_000;

async function runOneGeneration(
  user: ApiUser,
  item: ImagineItem,
  plan: GenerationPlan
): Promise<void> {
  const heartbeat = setInterval(() => {
    void patchItemRow(item.id, {}).catch(() => undefined);
  }, HEARTBEAT_MS);
  try {
    const engine = await resolveActiveEngine();
    try {
      const effectivePrompt = buildEffectivePrompt(plan, engine.kind === 'openai' ? 'exact' : 'creative-hint');
      let bytes: Buffer;
      let contentType: string;
      if (engine.kind === 'openai') {
        const result = await generateViaOpenAi(engine, effectivePrompt, plan.sourceImages ?? []);
        bytes = result.bytes;
        contentType = result.contentType;
      } else {
        const sources = plan.sourceImages?.length ? await resolveImageSources(plan.sourceImages) : [];
        const generated = await generateSdImage(effectivePrompt, null, {
          sourceImages: sources,
          onPhase: (phase) => {
            void setItemMeta(item.id, { phase }).catch(() => undefined);
          },
        });
        bytes = generated.bytes;
        contentType = generated.contentType;
      }

      // Persist through the files pipeline (existing architecture).
      const extension = contentType === 'image/jpeg' ? '.jpg' : contentType === 'image/webp' ? '.webp' : '.png';
      const fileItem = await uploadFileHandler(
        user,
        {
          bytes,
          filename: `imagine-${Date.now()}${extension}`,
          contentType,
        },
        { model: 'imagine-studio', source: 'imagine_studio', item_id: item.id },
        false
      );
      const fileId = fileItem?.id;
      if (!fileId) throw new Error('La sauvegarde de l’image a échoué.');

      // Dimensions via sharp (already a dependency).
      let width: number | null = null;
      let height: number | null = null;
      try {
        const metadata = await sharpMetadata(bytes);
        width = metadata.width ?? null;
        height = metadata.height ?? null;
      } catch {
        /* unreadable dims — stored as null */
      }

      await patchItemRow(item.id, {
        status: 'completed',
        file_id: fileId,
        provider: engine.kind === 'builtin' ? 'builtin' : 'openai',
        model: engine.kind === 'builtin' ? 'nelthai-imagine' : engine.openaiModel,
        width,
        height,
        meta: JSON.stringify({ style: plan.style ?? null, phase: null }),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'La génération d’image a échoué.';
      await patchItemRow(item.id, {
        status: 'failed',
        meta: JSON.stringify({ style: plan.style ?? null, phase: null, error: message }),
      }).catch(() => undefined);
    }
  } finally {
    clearInterval(heartbeat);
  }
}

async function sharpMetadata(bytes: Buffer): Promise<{ width?: number; height?: number }> {
  const sharp = (await import('sharp')).default;
  return sharp(bytes).metadata();
}

/** OpenAI Images API (generations / edits) — real size + multipart. */
async function generateViaOpenAi(
  engine: ActiveEngine,
  prompt: string,
  sourceImages: FileRefInput[]
): Promise<GeneratedImage> {
  const sources = sourceImages.length ? await resolveImageSources(sourceImages) : [];
  if (sources.length) {
    // Edits endpoint (multipart) — source bytes + prompt.
    const form = new FormData();
    form.append('model', engine.openaiModel);
    form.append('prompt', prompt);
    form.append('size', '1024x1024');
    for (const source of sources) {
      form.append(
        'image[]',
        new File(
          [new Uint8Array(source.bytes)],
          source.filename || 'input.png',
          { type: source.contentType || 'image/png' }
        )
      );
    }
    const res = await fetch(`${engine.openaiBaseUrl}/images/edits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${engine.openaiKey}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(await upstreamError(res));
    return openAiImageResponse(res);
  }
  const body: Record<string, unknown> = { model: engine.openaiModel, prompt, n: 1 };
  if (engine.openaiModel.startsWith('gpt-image')) body.quality = 'medium';
  const res = await fetch(`${engine.openaiBaseUrl}/images/generations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${engine.openaiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(await upstreamError(res));
  return openAiImageResponse(res);
}

async function upstreamError(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as { error?: { message?: string } };
    const message = body?.error?.message;
    if (message) return `Le moteur d’images a répondu : ${message}`;
  } catch {
    /* non-JSON */
  }
  return `Le moteur d’images a répondu HTTP ${res.status}.`;
}

async function openAiImageResponse(res: Response): Promise<GeneratedImage> {
  const result = (await res.json()) as {
    data?: Array<{ url?: string; b64_json?: string }>;
  };
  const first = result?.data?.[0];
  if (!first) throw new Error('Le moteur d’images n’a renvoyé aucune image.');
  if (first.b64_json) {
    return { bytes: Buffer.from(first.b64_json, 'base64'), contentType: 'image/png' };
  }
  if (first.url) {
    const download = await fetch(first.url, { signal: AbortSignal.timeout(60_000) });
    if (!download.ok) throw new Error('Téléchargement de l’image générée impossible.');
    const bytes = Buffer.from(await download.arrayBuffer());
    const contentType = (download.headers.get('content-type') || '').split(';')[0];
    return { bytes, contentType: contentType.startsWith('image/') ? contentType : 'image/png' };
  }
  throw new Error('Le moteur d’images n’a renvoyé aucune image.');
}

const WORKER_CONCURRENCY = 2;

/**
 * Background worker for a batch of queued items — scheduled by the router
 * through next/server `after()` so the POST returns immediately and the UI
 * polls the rows. Concurrency is capped to stay gentle with the gateway.
 */
export async function runGenerationBatch(
  user: ApiUser,
  batch: Array<{ item: ImagineItem; plan: GenerationPlan }>
): Promise<void> {
  const queue = [...batch];
  const runners = Array.from({ length: Math.min(WORKER_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      await runOneGeneration(user, next.item, next.plan);
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// Stale-row reaper (frozen-worker safety net)
// ---------------------------------------------------------------------------

const STALE_SECONDS = 1800;

/**
 * Rows stuck in generating/processing with NO sign of life for 30 minutes are
 * marked failed — the ONLY rows that can ever be reaped: the worker heartbeat
 * (runOneGeneration) bumps updated_at every 20s while a generation actually
 * runs, so a live generation — however slow the upstream — is NEVER
 * interrupted. This covers only a Vercel instance frozen mid-flight after its
 * response (no heartbeat anymore). Dialect-safe (Prisma only — no JSON_SET SQL
 * which differs between SQLite and Postgres).
 */
async function reapStaleItems(userId: string): Promise<void> {
  await ensureImageItemsTable();
  const cutoff = Math.floor(Date.now() / 1000) - STALE_SECONDS;
  const stale = (await db.imageItem.findMany({
    where: {
      user_id: userId,
      status: { in: ['generating', 'processing'] },
      OR: [{ updated_at: { lt: cutoff } }, { updated_at: null }],
    },
    select: { id: true, meta: true },
  })) as Array<{ id: string; meta: string | null }>;
  const message = 'Génération interrompue (délai dépassé) — relancez depuis la bibliothèque.';
  for (const row of stale) {
    const meta = { ...parseMeta(row.meta), phase: null, error: message };
    await db.imageItem
      .update({
        where: { id: row.id },
        data: { status: 'failed', meta: JSON.stringify(meta), updated_at: Math.floor(Date.now() / 1000) },
      })
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Public operations (used by the router)
// ---------------------------------------------------------------------------

const MAX_INFLIGHT = 8;

export interface GenerateItemsInput extends GenerationPlan {
  n?: number;
}

export async function queueGenerateItems(
  user: ApiUser,
  input: GenerateItemsInput
): Promise<ImagineItem[]> {
  await ensureImageItemsTable();
  await reapStaleItems(user.id);

  const inflight = await db.imageItem.count({
    where: { user_id: user.id, status: { in: ['generating', 'processing'] } },
  });
  if (inflight >= MAX_INFLIGHT) {
    throw new Error(
      `${inflight} générations sont déjà en cours — attendez qu’elles se terminent avant d’en lancer d’autres.`
    );
  }

  const engine = await resolveActiveEngine();
  const count = Math.max(1, Math.min(Math.round(input.n ?? 1), engine.kind === 'builtin' ? 4 : 4));
  const items: ImagineItem[] = [];
  for (let index = 0; index < count; index++) {
    items.push(
      await createQueuedItem(user, {
        prompt: input.prompt,
        style: input.style,
        aspectRatio: input.aspectRatio,
        source: input.sourceImages?.length ? 'edit' : 'generate',
      })
    );
  }
  return items;
}

/** Build the deferred batch for queued items (router schedules with after()). */
export function buildBatchPlan(
  items: ImagineItem[],
  input: GenerationPlan
): Array<{ item: ImagineItem; plan: GenerationPlan }> {
  return items.map((item) => ({ item, plan: input }));
}

export async function queueEditItem(
  user: ApiUser,
  itemId: string,
  prompt: string
): Promise<{ item: ImagineItem; plan: GenerationPlan }> {
  await ensureImageItemsTable();
  await reapStaleItems(user.id);

  const row = await getItemRow(itemId);
  if (!row || row.user_id !== user.id) {
    throw new Error('Image source introuvable.');
  }
  if (!row.file_id) {
    throw new Error('Cette image n’est pas encore disponible (génération en cours ?).');
  }

  const item = await createQueuedItem(user, {
    prompt,
    style: typeof parseMeta(row.meta).style === 'string' ? (parseMeta(row.meta).style as string) : undefined,
    aspectRatio: row.aspect_ratio ?? undefined,
    source: 'edit',
    parentId: row.id,
  });

  return {
    item,
    plan: {
      prompt,
      sourceImages: [{ url: `/api/v1/files/${row.file_id}/content`, type: 'image' }],
    },
  };
}

const VARIATION_PROMPT =
  'Crée une nouvelle variation de cette image : garde le sujet et l’esprit général, mais varie la pose, les détails et la composition de façon créative — image détaillée et de haute qualité';

export async function queueVariationItem(
  user: ApiUser,
  itemId: string
): Promise<{ item: ImagineItem; plan: GenerationPlan }> {
  await ensureImageItemsTable();
  await reapStaleItems(user.id);

  const row = await getItemRow(itemId);
  if (!row || row.user_id !== user.id) {
    throw new Error('Image source introuvable.');
  }
  if (!row.file_id) {
    throw new Error('Cette image n’est pas encore disponible (génération en cours ?).');
  }

  const item = await createQueuedItem(user, {
    prompt: row.prompt ? `${VARIATION_PROMPT} (inspiration : ${row.prompt})` : VARIATION_PROMPT,
    style: typeof parseMeta(row.meta).style === 'string' ? (parseMeta(row.meta).style as string) : undefined,
    aspectRatio: row.aspect_ratio ?? undefined,
    source: 'variation',
    parentId: row.id,
  });

  return {
    item,
    plan: {
      prompt: row.prompt ? `${VARIATION_PROMPT} (inspiration : ${row.prompt})` : VARIATION_PROMPT,
      sourceImages: [{ url: `/api/v1/files/${row.file_id}/content`, type: 'image' }],
    },
  };
}

export async function createUploadItem(
  user: ApiUser,
  bytes: Buffer,
  filename: string,
  contentType: string
): Promise<ImagineItem> {
  await ensureImageItemsTable();
  await reapStaleItems(user.id);

  let width: number | null = null;
  let height: number | null = null;
  try {
    const metadata = await sharpMetadata(bytes);
    width = metadata.width ?? null;
    height = metadata.height ?? null;
  } catch {
    /* not an image or unreadable — rejected earlier */
  }

  const fileItem = await uploadFileHandler(
    user,
    { bytes, filename, contentType },
    { model: 'imagine-studio', source: 'imagine_studio_upload' },
    false
  );
  const fileId = fileItem?.id;
  if (!fileId) throw new Error('L’enregistrement du fichier a échoué.');

  const now = Math.floor(Date.now() / 1000);
  const row = (await db.imageItem.create({
    data: {
      id: crypto.randomUUID(),
      user_id: user.id,
      name: filename,
      prompt: null,
      file_id: fileId,
      provider: 'local',
      model: null,
      status: 'completed',
      aspect_ratio: null,
      width,
      height,
      favorite: false,
      source: 'upload',
      parent_id: null,
      meta: JSON.stringify({ phase: null }),
      created_at: now,
      updated_at: now,
    },
  })) as ImageItemRow;
  return rowToItem(row);
}

// ---------------------------------------------------------------------------
// Library queries + mutations
// ---------------------------------------------------------------------------

export interface ListItemsQuery {
  type?: string;
  favorite?: boolean;
  q?: string;
  sinceDays?: number;
  limit?: number;
  offset?: number;
}

export async function listItems(
  user: ApiUser,
  query: ListItemsQuery
): Promise<ImagineItem[]> {
  await ensureImageItemsTable();
  await reapStaleItems(user.id);

  const where: Record<string, unknown> = { user_id: user.id };
  if (query.type && ['generate', 'edit', 'variation', 'upload'].includes(query.type)) {
    where.source = query.type;
  }
  if (query.favorite) where.favorite = true;
  if (query.sinceDays && query.sinceDays > 0) {
    const cutoff = Math.floor((Date.now() - query.sinceDays * 86400_000) / 1000);
    where.created_at = { gte: cutoff };
  }
  if (query.q?.trim()) {
    // Client-side filtering would be enough for 60 rows, but the DB can do
    // it with contains (SQLite LIKE via Prisma).
    where.OR = [
      { prompt: { contains: query.q.trim() } },
      { name: { contains: query.q.trim() } },
    ];
  }

  const rows = (await db.imageItem.findMany({
    where: where as never,
    orderBy: { created_at: 'desc' },
    take: Math.min(Math.max(query.limit ?? 60, 1), 200),
    skip: Math.max(query.offset ?? 0, 0),
  })) as ImageItemRow[];
  return rows.map(rowToItem);
}

export async function getItemForUser(user: ApiUser, id: string): Promise<ImagineItem | null> {
  const row = await getItemRow(id);
  if (!row || (row.user_id !== user.id && user.role !== 'admin')) return null;
  return rowToItem(row);
}

export async function patchItemForUser(
  user: ApiUser,
  id: string,
  patch: { name?: string; favorite?: boolean }
): Promise<ImagineItem | null> {
  const row = await getItemRow(id);
  if (!row || (row.user_id !== user.id && user.role !== 'admin')) return null;
  const data: Record<string, unknown> = {};
  if (typeof patch.name === 'string') {
    const name = patch.name.trim().slice(0, 120);
    if (!name) throw new Error('Le nom ne peut pas être vide.');
    data.name = name;
  }
  if (typeof patch.favorite === 'boolean') data.favorite = patch.favorite;
  if (Object.keys(data).length === 0) return rowToItem(row);
  const updated = await patchItemRow(id, data as { name: string; favorite: boolean });
  return updated ? rowToItem(updated) : null;
}

export async function deleteItemForUser(user: ApiUser, id: string): Promise<boolean> {
  await ensureImageItemsTable();
  const row = await getItemRow(id);
  if (!row || (row.user_id !== user.id && user.role !== 'admin')) return false;

  // Studio-created files can be deleted with their item; files shared with
  // chats (image_generation source) or other items are preserved.
  if (row.file_id) {
    const fileMetaSource = await fileStudioSource(row.file_id);
    const otherItems = await db.imageItem.count({
      where: { file_id: row.file_id, id: { not: row.id } },
    });
    if (fileMetaSource && otherItems === 0) {
      try {
        await db.file.delete({ where: { id: row.file_id } });
      } catch {
        /* file already gone */
      }
    }
  }
  await db.imageItem.delete({ where: { id: row.id } });
  return true;
}

async function fileStudioSource(fileId: string): Promise<boolean> {
  try {
    const file = await db.file.findUnique({ where: { id: fileId } });
    if (!file?.meta) return false;
    const meta = parseMeta(file.meta);
    const nested = (meta.data ?? {}) as Record<string, unknown>;
    const source = nested.source;
    return source === 'imagine_studio' || source === 'imagine_studio_upload';
  } catch {
    return false;
  }
}
