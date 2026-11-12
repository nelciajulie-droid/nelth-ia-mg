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
 *     V3/GIF : les N variations d'une action partagent UNE SEULE requête
 *     Nelthai — le compte voyage dans le prompt (« N IMAGES ») et les
 *     images rendues se répartissent sur les lignes (runNelthaiGroup).
 *     V3/GIF reste STRICTEMENT en envoi de groupe : moins d'images rendues
 *     ou échec du job unique → les lignes échouent, jamais de repli
 *     une-par-une (règle utilisateur).
 *     V2 t2i et vidéo t2v : idem via le paramètre NATIF « variations » de
 *     la passerelle vibes — une seule action pour toute la génération
 *     (runVibesImageGroup / runVideoGroup).
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
  generateSdImages,
  resolveImageSources,
  type FileRefInput,
  type GeneratedImage,
} from '@/lib/image-generation';
import {
  normalizeVibesAspectRatio,
  normalizeVibesResolution,
} from '@/lib/imagine/vibes';
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
  // MODE INVITÉ (ChatGPT parity): the Images studio is locked for anonymous
  // guests — image generation is a signed-in feature.
  {
    const { isGuestUser } = await import('@/lib/guests');
    if (isGuestUser(user)) {
      throw new Error('La génération d’images est réservée aux comptes gratuits. Créez un compte pour accéder au studio.');
    }
  }
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
  /** Catégorie de média : image (défaut), vidéo ou GIF. */
  kind?: 'image' | 'video' | 'gif';
  /** Modèle : 'v2' (vibes) ou 'v3' (nelthai) — indéfini → moteur actif. */
  model?: 'v2' | 'v3';
  /** Résolution vidéo (480p/720p) — catégorie vidéo uniquement. */
  resolution?: '480p' | '720p';
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

/**
 * Directive GIF — accolée au prompt utilisateur en mode GIF : le V3 (seul
 * modèle GIF) doit TOUJOURS produire un GIF animé, jamais une image fixe.
 */
const GIF_MODE_DIRECTIVE =
  'Generate an animated GIF: a seamless looping animation with smooth, fluid motion. The output MUST be an animated GIF image, not a static picture.';

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
  kind?: 'image' | 'video' | 'gif';
  model?: 'v2' | 'v3';
  resolution?: '480p' | '720p';
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
        kind: input.kind ?? 'image',
        model: input.model ?? null,
        resolution: input.resolution ?? null,
      }),
      created_at: now,
      updated_at: now,
    },
  })) as ImageItemRow;
  return rowToItem(row);
}

async function sharpMetadata(bytes: Buffer): Promise<{ width?: number; height?: number }> {
  const sharp = (await import('sharp')).default;
  return sharp(bytes).metadata();
}

// ---------------------------------------------------------------------------
// Persistence — bytes through the files pipeline (image, GIF et vidéo).
// ---------------------------------------------------------------------------

function mediaExtension(contentType: string, kind: string): string {
  if (kind === 'video') return '.mp4';
  if (contentType === 'image/gif') return '.gif';
  if (contentType === 'image/jpeg') return '.jpg';
  if (contentType === 'image/webp') return '.webp';
  return '.png';
}

async function persistGeneratedMedia(
  user: ApiUser,
  item: ImagineItem,
  plan: GenerationPlan,
  bytes: Buffer,
  contentType: string,
  identity: { provider: string; model: string }
): Promise<void> {
  const kind = plan.kind ?? 'image';
  const extension = mediaExtension(contentType, kind);
  const fileItem = await uploadFileHandler(
    user,
    {
      bytes,
      filename: `imagine-${kind}-${Date.now()}${extension}`,
      contentType,
    },
    { model: 'imagine-studio', source: 'imagine_studio', item_id: item.id },
    false
  );
  const fileId = fileItem?.id;
  if (!fileId) throw new Error('La sauvegarde du média a échoué.');

  // Dimensions via sharp (images uniquement — pas les vidéos).
  let width: number | null = null;
  let height: number | null = null;
  if (kind !== 'video') {
    try {
      const metadata = await sharpMetadata(bytes);
      width = metadata.width ?? null;
      height = metadata.height ?? null;
    } catch {
      /* unreadable dims — stored as null */
    }
  }

  await patchItemRow(item.id, {
    status: 'completed',
    file_id: fileId,
    provider: identity.provider,
    model: identity.model,
    width,
    height,
    meta: JSON.stringify({
      style: plan.style ?? null,
      phase: null,
      kind,
      model: plan.model ?? (kind === 'video' ? 'v2' : kind === 'gif' ? 'v3' : null),
      resolution: plan.resolution ?? null,
    }),
  });
}

// ---------------------------------------------------------------------------
// Nelth-V2 — image (vibes gateway) : texte→image et image→image (édition).
// ---------------------------------------------------------------------------

/** Bytes d'une source (upload vibes obligatoire) — télécharge les URLs nues. */
async function sourceBytesOf(
  source: Awaited<ReturnType<typeof resolveImageSources>>[number]
): Promise<{ bytes: Buffer; filename: string; contentType: string }> {
  if (source.kind === 'bytes') {
    return {
      bytes: source.bytes,
      filename: source.filename || 'input.png',
      contentType: source.contentType || 'image/png',
    };
  }
  const res = await fetch(source.url, {
    headers: { accept: 'image/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`L'image source est illisible (HTTP ${res.status}).`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) throw new Error('L’image source est vide.');
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
  return {
    bytes,
    filename: `input${mediaExtension(contentType, 'image')}`,
    contentType: contentType.startsWith('image/') ? contentType : 'image/png',
  };
}

async function runVibesImageGeneration(
  user: ApiUser,
  item: ImagineItem,
  plan: GenerationPlan
): Promise<void> {
  const vibes = await import('@/lib/imagine/vibes');
  // V2 : l'aspect_ratio est un VRAI paramètre gateway (1:1, 16:9, 9:16) —
  // jamais de hint de composition dans le prompt.
  const effectivePrompt = buildEffectivePrompt(plan, 'none');
  const sources = plan.sourceImages?.length ? await resolveImageSources(plan.sourceImages) : [];

  let imageUrl: string;
  if (sources.length) {
    // Image→image : upload dans le store vibes (mediaEntId obligatoire) →
    // édition (auto-enhance du prompt via /api/prompts/enhance).
    await setItemMeta(item.id, { phase: 'sending' });
    const source = await sourceBytesOf(sources[0]);
    const uploaded = await vibes.vibesUploadImage({
      bytes: source.bytes,
      filename: source.filename,
      contentType: source.contentType,
    });
    await setItemMeta(item.id, { phase: 'generating' });
    const edited = await vibes.vibesEditImage({
      sourceImageEntId: uploaded.sourceImageEntId ?? uploaded.mediaEntId,
      editPrompt: effectivePrompt,
      allMediaEntIds: uploaded.allMediaEntIds,
    });
    imageUrl = edited.imageUrl;
  } else {
    // Texte→image : repli individuel (ligne orpheline d'un groupe, édit…).
    // Le chemin normal d'une génération multi-variations est le GROUPE
    // (runVibesImageGroup) — le paramètre natif « variations » de la
    // passerelle couvre toute l'action en une seule fois.
    await setItemMeta(item.id, { phase: 'sending' });
    const results = await vibes.vibesGenerateImages({
      prompt: effectivePrompt,
      aspectRatio: plan.aspectRatio,
      variations: 1,
    });
    if (!results.length) throw new Error('La génération a échoué.');
    await setItemMeta(item.id, { phase: 'generating' });
    imageUrl = results[0].url;
  }

  await persistVibesImage(user, item, plan, imageUrl);
}

/**
 * Nettoyage watermark + logo (repli : téléchargement direct des octets)
 * puis persistance — partagé par le chemin individuel V2 et le groupe.
 */
async function persistVibesImage(
  user: ApiUser,
  item: ImagineItem,
  plan: GenerationPlan,
  imageUrl: string
): Promise<void> {
  const vibes = await import('@/lib/imagine/vibes');
  await setItemMeta(item.id, { phase: 'image' });
  let bytes: Buffer;
  let contentType: string;
  try {
    const cleaned = await vibes.vibesCleanImageBlob(imageUrl);
    bytes = cleaned.bytes;
    contentType = cleaned.contentType;
  } catch {
    const raw = await vibes.downloadVibesImage(imageUrl);
    bytes = raw.bytes;
    contentType = raw.contentType;
  }

  await persistGeneratedMedia(user, item, plan, bytes, contentType, {
    provider: 'vibes',
    model: 'nelth-v2',
  });
}

/**
 * V2 t2i — génération de GROUPE : la passerelle vibes expose un paramètre
 * natif « variations » (vibesGenerateImages) — UNE SEULE action service
 * couvre toutes les lignes d'une même génération, au lieu d'un appel par
 * ligne. Le client gère lui-même le fan-out gateway-safe (plusieurs appels
 * parallèles de 1 variation — le gateway images time-out au-delà de 1) et
 * rend jusqu'à N URLs ; la i-ème URL → i-ème ligne.
 *
 * Repli robuste — le pire cas égale l'ancien comportement : moins d'images
 * que demandé → lignes orphelines en génération individuelle ; échec total
 * → repli intégral une-par-une (miroir de runNelthaiGroup). L'i2i V2 est
 * verrouillé à 1 variation → jamais ici.
 */
async function runVibesImageGroup(
  user: ApiUser,
  entries: GenerationBatchEntry[]
): Promise<void> {
  const items = entries.map((entry) => entry.item);
  const plan = entries[0].plan;
  const requested = Math.max(1, Math.min(entries[0].requested ?? items.length, 4));

  const heartbeats = items.map((item) =>
    setInterval(() => {
      void patchItemRow(item.id, {}).catch(() => undefined);
    }, HEARTBEAT_MS)
  );

  try {
    const vibes = await import('@/lib/imagine/vibes');
    // V2 : l'aspect_ratio est un VRAI paramètre gateway — jamais de hint de
    // composition dans le prompt (parité exacte avec le chemin individuel).
    const effectivePrompt = buildEffectivePrompt(plan, 'none');
    const broadcastPhase = (phase: string) => {
      for (const item of items) {
        void setItemMeta(item.id, { phase }).catch(() => undefined);
      }
    };

    console.log(
      `[imagine] groupe V2 : 1 action vibes (variations=${requested}) pour ${items.length} ligne(s)`
    );

    broadcastPhase('sending');
    const results = await vibes.vibesGenerateImages({
      prompt: effectivePrompt,
      aspectRatio: plan.aspectRatio,
      variations: requested,
    });
    if (!results.length) throw new Error('La génération a échoué.');
    broadcastPhase('generating');

    for (let index = 0; index < items.length; index++) {
      const result: { url: string } | undefined = results[index];
      if (result) {
        try {
          await persistVibesImage(user, items[index], plan, result.url);
        } catch (err) {
          await failItem(items[index], plan, err);
        }
      } else {
        // Ligne orpheline (le moteur a rendu moins d'images que demandé) →
        // génération individuelle, comme avant.
        console.log(
          `[imagine] groupe V2 : ${results.length}/${requested} image(s) rendues — ligne ${index + 1} en génération individuelle`
        );
        await runOneGeneration(user, items[index], plan);
      }
    }
  } catch {
    // Action de groupe morte → repli intégral une-par-une.
    console.warn('[imagine] groupe V2 : action unique échouée — repli individuel par ligne');
    for (const entry of entries) {
      await runOneGeneration(user, entry.item, entry.plan);
    }
  } finally {
    for (const heartbeat of heartbeats) clearInterval(heartbeat);
  }
}

// ---------------------------------------------------------------------------
// Nelth-V3 — image & GIF (nelthai metaai) : texte→image, image→image
// multi-sources. En mode GIF, la directive boucle TOUJOURS le prompt.
// ---------------------------------------------------------------------------

async function runNelthaiImageGeneration(
  user: ApiUser,
  item: ImagineItem,
  plan: GenerationPlan,
  isGif: boolean
): Promise<void> {
  // Le moteur Nelthai instant choisit sa taille de sortie — le ratio voyage
  // comme guidage de composition dans le prompt (jamais un faux paramètre).
  let effectivePrompt = buildEffectivePrompt(plan, 'creative-hint');
  if (isGif) effectivePrompt = `${effectivePrompt} ${GIF_MODE_DIRECTIVE}`.trim();

  const sources = plan.sourceImages?.length ? await resolveImageSources(plan.sourceImages) : [];
  const generated = await generateSdImage(effectivePrompt, null, {
    sourceImages: sources,
    onPhase: (phase) => {
      void setItemMeta(item.id, { phase }).catch(() => undefined);
    },
  });

  await persistGeneratedMedia(user, item, plan, generated.bytes, generated.contentType, {
    provider: 'builtin',
    model: isGif ? 'nelth-v3-gif' : 'nelth-v3',
  });
}

/**
 * Directive de compte V3/GIF — la quantité demandée voyage DANS le prompt :
 * « 3 IMAGES » pour 3 variations, « 1 IMAGE » pour une seule. Le moteur
 * Nelthai rend alors les N images d'un SEUL job (image_urls[]) au lieu de
 * N requêtes envoyées une à une. V2 et vidéo n'ont pas besoin de directive :
 * leurs passerelles vibes exposent un paramètre NATIF « variations », pris
 * en charge par leurs propres groupes (runVibesImageGroup / runVideoGroup).
 */
function nelthaiCountDirective(count: number): string {
  return count > 1
    ? `Generate exactly ${count} different images (${count} IMAGES).`
    : 'Generate exactly 1 image (1 IMAGE).';
}

/** Marque une ligne en échec (miroir du catch de runOneGeneration). */
async function failItem(item: ImagineItem, plan: GenerationPlan, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : 'La génération a échoué.';
  await patchItemRow(item.id, {
    status: 'failed',
    meta: JSON.stringify({
      style: plan.style ?? null,
      phase: null,
      kind: plan.kind ?? 'image',
      model: plan.model ?? null,
      resolution: plan.resolution ?? null,
      error: message,
    }),
  }).catch(() => undefined);
}

/**
 * V3/GIF — génération de GROUPE : UNE SEULE requête Nelthai pour toutes les
 * lignes d'une même action de génération. Le compte demandé voyage dans le
 * prompt (nelthaiCountDirective) et les images rendues par le job unique se
 * répartissent sur les lignes (la i-ème image → i-ème ligne).
 *
 * Règle utilisateur — V3/GIF = TOUJOURS l'envoi de groupe, JAMAIS de repli
 * une-par-une (plus aucun runOneGeneration ici) :
 *   • le moteur rend MOINS d'images que demandé → les lignes orphelines sont
 *     marquées en échec (failItem) — l'utilisateur relance l'action entière ;
 *   • la requête de groupe échoue → TOUTES les lignes sont marquées en échec
 *     avec l'erreur du groupe — aucune relance individuelle.
 * (V2 t2i et vidéo t2v gardent leur repli : leur passerelle vibes expose un
 * paramètre NATIF « variations », pas un compte dans le prompt.)
 *
 * Heartbeats pour TOUTES les lignes pendant que la requête unique tourne —
 * le reaper ne peut pas faucher un groupe vivant.
 */
async function runNelthaiGroup(
  user: ApiUser,
  entries: GenerationBatchEntry[]
): Promise<void> {
  const items = entries.map((entry) => entry.item);
  const plan = entries[0].plan;
  const isGif = (plan.kind ?? 'image') === 'gif';
  const requested = Math.max(1, Math.min(entries[0].requested ?? items.length, 8));

  const heartbeats = items.map((item) =>
    setInterval(() => {
      void patchItemRow(item.id, {}).catch(() => undefined);
    }, HEARTBEAT_MS)
  );

  try {
    // Prompt effectif : suffixe de style + hint de ratio (+ directive GIF)
    // + directive de compte — la quantité fait partie de la demande.
    let effectivePrompt = buildEffectivePrompt(plan, 'creative-hint');
    if (isGif) effectivePrompt = `${effectivePrompt} ${GIF_MODE_DIRECTIVE}`.trim();
    const directive = nelthaiCountDirective(requested);
    effectivePrompt = `${effectivePrompt} ${directive}`.trim();

    console.log(
      `[imagine] groupe V3/GIF : 1 requête unique pour ${items.length} ligne(s) — « ${directive} »`
    );

    const sources = plan.sourceImages?.length ? await resolveImageSources(plan.sourceImages) : [];
    const broadcastPhase = (phase: string) => {
      for (const item of items) {
        void setItemMeta(item.id, { phase }).catch(() => undefined);
      }
    };

    const generated = await generateSdImages(effectivePrompt, requested, {
      sourceImages: sources,
      onPhase: broadcastPhase,
    });

    for (let index = 0; index < items.length; index++) {
      const image: GeneratedImage | undefined = generated[index];
      if (image) {
        try {
          await persistGeneratedMedia(user, items[index], plan, image.bytes, image.contentType, {
            provider: 'builtin',
            model: isGif ? 'nelth-v3-gif' : 'nelth-v3',
          });
        } catch (err) {
          await failItem(items[index], plan, err);
        }
      } else {
        // Ligne orpheline (le moteur a rendu moins d'images que demandé) →
        // échec affiché, JAMAIS de génération individuelle : V3/GIF reste
        // strictement en envoi de groupe (règle utilisateur).
        console.log(
          `[imagine] groupe V3/GIF : ${generated.length}/${requested} image(s) rendues — ligne ${index + 1} marquée en échec (pas de repli individuel)`
        );
        await failItem(
          items[index],
          plan,
          new Error(
            `La génération de groupe n'a livré que ${generated.length}/${requested} image(s) — relancez l'action pour retenter l'envoi de groupe.`
          )
        );
      }
    }
  } catch (err) {
    // Requête de groupe morte → TOUTES les lignes échouent avec l'erreur.
    // Aucun repli une-par-une : V3/GIF est TOUJOURS en envoi de groupe.
    console.warn('[imagine] groupe V3/GIF : requête unique échouée — lignes marquées en échec, pas de repli individuel');
    for (const entry of entries) {
      await failItem(entry.item, entry.plan, err);
    }
  } finally {
    for (const heartbeat of heartbeats) clearInterval(heartbeat);
  }
}

// ---------------------------------------------------------------------------
// Vidéo (vibes) — texte→vidéo (ratio 1:1/16:9/9:16 + résolution 480p/720p)
// et image→vidéo (animate : le ratio suit l'image source).
// ---------------------------------------------------------------------------

async function runVideoGeneration(
  user: ApiUser,
  item: ImagineItem,
  plan: GenerationPlan
): Promise<void> {
  const { generateVideo } = await import('@/lib/video-generation');
  const resolution = normalizeVibesResolution(plan.resolution);
  const phaseOf = (phase: string): string =>
    phase === 'sending' ? 'sending' : phase === 'rendering' ? 'generating' : 'image';

  const sources = plan.sourceImages?.length ? await resolveImageSources(plan.sourceImages) : [];
  const sourceImage = sources.length
    ? await (async () => {
        const source = await sourceBytesOf(sources[0]);
        return {
          bytes: source.bytes,
          contentType: source.contentType,
          filename: source.filename,
        };
      })()
    : undefined;

  const { bytes, contentType } = await generateVideo(plan.prompt, {
    aspectRatio: normalizeVibesAspectRatio(plan.aspectRatio),
    resolution,
    sourceImage,
    onPhase: (phase) => {
      void setItemMeta(item.id, { phase: phaseOf(phase) }).catch(() => undefined);
    },
  });

  await persistGeneratedMedia(user, item, plan, bytes, contentType, {
    provider: 'vibes',
    model: 'nelth-v2-video',
  });
}

/**
 * Vidéo t2v — génération de GROUPE : la passerelle vibes expose un paramètre
 * natif « variations » — UNE SEULE soumission de batch couvre toutes les
 * lignes d'une même génération (le batch rend N vidéos dans content[]) au
 * lieu de N soumissions une-par-une. La i-ème vidéo → i-ème ligne.
 *
 * Repli robuste — le pire cas égale l'ancien comportement : moins de vidéos
 * que demandé → lignes orphelines en génération individuelle ; échec total
 * → repli intégral une-par-une (miroir de runNelthaiGroup). L'i2v est
 * verrouillé à 1 variation → jamais ici (le ratio suit l'image source).
 */
async function runVideoGroup(
  user: ApiUser,
  entries: GenerationBatchEntry[]
): Promise<void> {
  const items = entries.map((entry) => entry.item);
  const plan = entries[0].plan;
  const requested = Math.max(1, Math.min(entries[0].requested ?? items.length, 4));

  const heartbeats = items.map((item) =>
    setInterval(() => {
      void patchItemRow(item.id, {}).catch(() => undefined);
    }, HEARTBEAT_MS)
  );

  try {
    const { generateVideos } = await import('@/lib/video-generation');
    const resolution = normalizeVibesResolution(plan.resolution);
    const phaseOf = (phase: string): string =>
      phase === 'sending' ? 'sending' : phase === 'rendering' ? 'generating' : 'image';
    const broadcastPhase = (phase: string) => {
      for (const item of items) {
        void setItemMeta(item.id, { phase: phaseOf(phase) }).catch(() => undefined);
      }
    };

    console.log(
      `[imagine] groupe vidéo : 1 soumission unique (variations=${requested}) pour ${items.length} ligne(s)`
    );

    // Parité exacte avec le chemin individuel : prompt BRUT (le ratio et la
    // résolution sont de VRAIS paramètres gateway, jamais de hint prompt).
    const videos = await generateVideos(plan.prompt, requested, {
      aspectRatio: normalizeVibesAspectRatio(plan.aspectRatio),
      resolution,
      onPhase: broadcastPhase,
    });

    for (let index = 0; index < items.length; index++) {
      const video: { bytes: Buffer; contentType: string } | undefined = videos[index];
      if (video) {
        try {
          await persistGeneratedMedia(user, items[index], plan, video.bytes, video.contentType, {
            provider: 'vibes',
            model: 'nelth-v2-video',
          });
        } catch (err) {
          await failItem(items[index], plan, err);
        }
      } else {
        console.log(
          `[imagine] groupe vidéo : ${videos.length}/${requested} vidéo(s) rendues — ligne ${index + 1} en génération individuelle`
        );
        await runOneGeneration(user, items[index], plan);
      }
    }
  } catch {
    console.warn(
      '[imagine] groupe vidéo : soumission unique échouée — repli individuel par ligne'
    );
    for (const entry of entries) {
      await runOneGeneration(user, entry.item, entry.plan);
    }
  } finally {
    for (const heartbeat of heartbeats) clearInterval(heartbeat);
  }
}

// ---------------------------------------------------------------------------
// Legacy — moteur actif (aucun modèle explicite : OpenAI configuré ou
// Nelthai intégré). Comportement historique du studio et du chat.
// ---------------------------------------------------------------------------

async function runEngineGeneration(
  user: ApiUser,
  item: ImagineItem,
  plan: GenerationPlan
): Promise<void> {
  const engine = await resolveActiveEngine();
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
  await persistGeneratedMedia(user, item, plan, bytes, contentType, {
    provider: engine.kind === 'builtin' ? 'builtin' : 'openai',
    model: engine.kind === 'builtin' ? 'nelthai-imagine' : engine.openaiModel,
  });
}

const HEARTBEAT_MS = 20_000;

/** Une ligne mise en file + son plan + le compte demandé par l'action. */
export interface GenerationBatchEntry {
  item: ImagineItem;
  plan: GenerationPlan;
  /**
   * Nombre de médias demandés par CETTE action de génération — c'est le
   * ticket d'entrée des GROUPES : V3/GIF → la quantité voyage dans le prompt
   * (« N IMAGES », runNelthaiGroup) ; V2 t2i et vidéo t2v → paramètre NATIF
   * « variations » de la passerelle vibes (runVibesImageGroup /
   * runVideoGroup). Une seule requête/soumission pour toute l'action au lieu
   * de N envois une-par-une. Absent pour édit/variations : une ligne = une
   * image, pas de compte sur ces chemins.
   */
  requested?: number;
}

/**
 * Generate + persist one item, ROUTED by the explicit plan:
 *
 *   kind=video            → vibes vidéo (t2v ou i2v, 480p/720p)
 *   kind=gif              → Nelth-V3 + directive GIF (V3 = seul modèle GIF)
 *   kind=image, model=v2  → vibes image (t2i ratio réel, i2i upload+edit)
 *   kind=image, model=v3  → nelthai (t2i, i2i multi-sources)
 *   aucun modèle          → moteur actif (legacy, comportement inchangé)
 *
 * Les GÉNÉRATIONS multi-variations passent par leur groupe dédié (une
 * requête/soumission unique pour toute l'action : runNelthaiGroup pour
 * V3/GIF, runVibesImageGroup / runVideoGroup pour le paramètre natif
 * vibes) — ce routeur individuel ne sert que de repli (ligne orpheline,
 * édit, variation, i2i/i2v).
 *
 * A HEARTBEAT bumps the row's updated_at every 20s while this worker runs —
 * the stale reaper can then NEVER interrupt a live generation (however
 * slow the upstream): it only fires for rows whose worker died
 * (serverless freeze), 30 minutes after the last sign of life.
 */
async function runOneGeneration(
  user: ApiUser,
  item: ImagineItem,
  plan: GenerationPlan
): Promise<void> {
  const heartbeat = setInterval(() => {
    void patchItemRow(item.id, {}).catch(() => undefined);
  }, HEARTBEAT_MS);
  try {
    const kind = plan.kind ?? 'image';
    if (kind === 'video') {
      await runVideoGeneration(user, item, plan);
    } else if (plan.model === 'v2') {
      await runVibesImageGeneration(user, item, plan);
    } else if (kind === 'gif' || plan.model === 'v3') {
      await runNelthaiImageGeneration(user, item, plan, kind === 'gif');
    } else {
      await runEngineGeneration(user, item, plan);
    }
  } catch (err) {
    await failItem(item, plan, err);
  } finally {
    clearInterval(heartbeat);
  }
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
 *
 * Une action de génération multi-variations = UN SEUL envoi côté passerelle,
 * quel que soit le modèle : V3/GIF → le compte voyage dans le prompt
 * (« N IMAGES », runNelthaiGroup) ; V2 t2i et vidéo t2v → paramètre NATIF
 * « variations » de la passerelle vibes (runVibesImageGroup / runVideoGroup).
 * Les chemins verrouillés à 1 (i2i V2, i2v), le legacy et l'édit/variations
 * restent une requête par ligne avec la concurrence historique.
 */
export async function runGenerationBatch(
  user: ApiUser,
  batch: Array<{ item: ImagineItem; plan: GenerationPlan; requested?: number }>
): Promise<void> {
  // Partition : groupes d'une même action (même plan = mêmes paramètres) vs
  // le reste (item par item).
  const groups = new Map<GenerationPlan, GenerationBatchEntry[]>();
  const singles: GenerationBatchEntry[] = [];
  for (const entry of batch) {
    const kind = entry.plan.kind ?? 'image';
    const hasSources = (entry.plan.sourceImages?.length ?? 0) > 0;
    const groupable =
      typeof entry.requested === 'number' &&
      entry.requested >= 1 &&
      (
        // V3/GIF (t2i et i2i) — compte dans le prompt (984127a).
        (kind !== 'video' && (kind === 'gif' || entry.plan.model === 'v3')) ||
        // Vidéo t2v — paramètre natif « variations » (i2v verrouillé à 1,
        // jamais groupé : le ratio suit l'image source).
        (kind === 'video' && !hasSources) ||
        // V2 t2i — paramètre natif « variations » (i2i V2 verrouillé à 1).
        (kind === 'image' && entry.plan.model === 'v2' && !hasSources)
      );
    if (groupable) {
      const group = groups.get(entry.plan) ?? [];
      group.push(entry);
      groups.set(entry.plan, group);
    } else {
      singles.push(entry);
    }
  }

  const runners: Array<Promise<void>> = [];
  for (const group of groups.values()) {
    const plan = group[0].plan;
    const kind = plan.kind ?? 'image';
    if (kind === 'video') {
      runners.push(runVideoGroup(user, group));
    } else if (kind === 'image' && plan.model === 'v2') {
      runners.push(runVibesImageGroup(user, group));
    } else {
      runners.push(runNelthaiGroup(user, group));
    }
  }

  const queue = [...singles];
  const workers = Array.from({ length: Math.min(WORKER_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      await runOneGeneration(user, next.item, next.plan);
    }
  });
  runners.push(...workers);
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

  const kind = input.kind ?? 'image';
  const hasSources = (input.sourceImages?.length ?? 0) > 0;
  // Règles de variations (miroir exact du composeur) :
  //   image→image Nelth-V2 et image→vidéo → 1 SEULE variation ;
  //   tout le reste (V3 t2i/i2i, V2 t2i, vidéo t2v, GIF) → 1 à 4.
  const lockedToOne =
    hasSources && (kind === 'video' || (kind === 'image' && input.model === 'v2'));
  const engine = await resolveActiveEngine();
  const count = lockedToOne
    ? 1
    : Math.max(1, Math.min(Math.round(input.n ?? 1), engine.kind === 'builtin' ? 4 : 4));
  const items: ImagineItem[] = [];
  for (let index = 0; index < count; index++) {
    items.push(
      await createQueuedItem(user, {
        prompt: input.prompt,
        style: input.style,
        aspectRatio: input.aspectRatio,
        source: hasSources ? 'edit' : 'generate',
        kind,
        model: input.model,
        resolution: input.resolution,
      })
    );
  }
  return items;
}

/** Build the deferred batch for queued items (router schedules with after()).
 *
 * `requested` = le nombre de lignes créées par l'action — c'est le compte
 * effectif après les verrous serveur (queueGenerateItems ne crée que les
 * lignes autorisées : i2i V2 et i2v → 1). Il voyage avec l'entrée pour que
 * le worker construise l'envoi unique de l'action : directive « N IMAGES »
 * dans le prompt pour V3/GIF, paramètre natif « variations » pour V2 t2i et
 * vidéo t2v. */
export function buildBatchPlan(
  items: ImagineItem[],
  input: GenerationPlan
): GenerationBatchEntry[] {
  const requested = items.length;
  return items.map((item) => ({ item, plan: input, requested }));
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

  // L'édition d'un média hérite du modèle de son parent (éditer une image
  // V2 reste V2, réimaginer un GIF reste un GIF) — jamais de bascule sournoise.
  const parentMeta = parseMeta(row.meta);
  const parentKind =
    parentMeta.kind === 'video'
      ? undefined // une vidéo ne s'édite pas en image — refusé plus bas
      : parentMeta.kind === 'gif'
        ? ('gif' as const)
        : undefined;
  const parentModel =
    parentMeta.model === 'v2' || parentMeta.model === 'v3' ? parentMeta.model : undefined;

  const item = await createQueuedItem(user, {
    prompt,
    style: typeof parentMeta.style === 'string' ? (parentMeta.style as string) : undefined,
    aspectRatio: row.aspect_ratio ?? undefined,
    source: 'edit',
    parentId: row.id,
    kind: parentKind ?? 'image',
    model: parentModel,
  });

  return {
    item,
    plan: {
      prompt,
      kind: parentKind ?? 'image',
      model: parentModel,
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

  // La variation hérite elle aussi du modèle/kind du parent (un GIF reste
  // un GIF via la directive, une image V2 reste V2).
  const parentMeta = parseMeta(row.meta);
  const parentKind =
    parentMeta.kind === 'gif' ? ('gif' as const) : parentMeta.kind === 'video' ? undefined : undefined;
  const parentModel =
    parentMeta.model === 'v2' || parentMeta.model === 'v3' ? parentMeta.model : undefined;
  const variationPrompt = row.prompt
    ? `${VARIATION_PROMPT} (inspiration : ${row.prompt})`
    : VARIATION_PROMPT;

  const item = await createQueuedItem(user, {
    prompt: variationPrompt,
    style: typeof parentMeta.style === 'string' ? (parentMeta.style as string) : undefined,
    aspectRatio: row.aspect_ratio ?? undefined,
    source: 'variation',
    parentId: row.id,
    kind: parentKind ?? 'image',
    model: parentModel,
  });

  return {
    item,
    plan: {
      prompt: variationPrompt,
      kind: parentKind ?? 'image',
      model: parentModel,
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
