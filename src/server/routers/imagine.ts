import type { Route, Ctx } from '../http';
import { HttpError } from '../http';
import { after } from 'next/server';

/**
 * Nelth-IA Images — studio router (/api/v1/imagine/*).
 *
 * Mounted through the central registry (V1_MOUNTS) like every other router:
 *
 *   GET    /capabilities            engine + honest feature map for the UI
 *   POST   /generate                queue N items → deferred worker (after())
 *   POST   /edit                    image + instructions → image-to-image
 *   POST   /variations              new item derived from a parent image
 *   POST   /upload                  import an image into the library
 *   GET    /items                   library list (filters + stale reaper)
 *   GET    /items/:id               single item (detail view)
 *   PATCH  /items/:id               rename / favorite
 *   DELETE /items/:id               remove (studio-owned files with the row)
 *
 * Validation mirrors the app's FastAPI parity: {"detail": "..."} error bodies,
 * 401/403 through the shared auth gate, ownership enforced in the service.
 */

function err(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

type FileRef = { id?: string; url?: string; name?: string; type?: string };

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const routes: Route[] = [
  // ------------------- GET /capabilities -------------------
  {
    method: 'GET',
    path: 'capabilities',
    auth: 'user',
    handler: async (ctx) => {
      const { getImagineCapabilities } = await import('@/lib/images/service');
      return ctx.json(await getImagineCapabilities());
    },
  },

  // ------------------- GET /items -------------------
  {
    method: 'GET',
    path: 'items',
    auth: 'user',
    handler: async (ctx) => {
      const { listItems } = await import('@/lib/images/service');
      const items = await listItems(ctx.user!, {
        type: ctx.query.get('type') ?? undefined,
        favorite: ctx.query.get('favorite') === 'true',
        q: ctx.query.get('q') ?? undefined,
        sinceDays: ctx.query.get('since_days') ? Number(ctx.query.get('since_days')) : undefined,
        limit: ctx.query.get('limit') ? Number(ctx.query.get('limit')) : undefined,
        offset: ctx.query.get('offset') ? Number(ctx.query.get('offset')) : undefined,
      });
      return ctx.json({ items });
    },
  },

  // ------------------- GET /items/:id -------------------
  {
    method: 'GET',
    path: 'items/:id',
    auth: 'user',
    handler: async (ctx) => {
      const { getItemForUser } = await import('@/lib/images/service');
      const item = await getItemForUser(ctx.user!, ctx.params.id);
      if (!item) err(404, 'Image introuvable.');
      return ctx.json(item);
    },
  },

  // ------------------- POST /generate -------------------
  {
    method: 'POST',
    path: 'generate',
    auth: 'user',
    handler: async (ctx) => {
      const service = await import('@/lib/images/service');
      try {
        await service.assertStudioPermission(ctx.user!);
      } catch (e) {
        err(403, e instanceof Error ? e.message : 'Génération d’images interdite.');
      }

      const form = await ctx.body<{
        prompt?: string;
        aspectRatio?: string;
        style?: string;
        n?: number;
        sourceImages?: FileRef[];
        kind?: 'image' | 'video' | 'gif';
        model?: 'v2' | 'v3';
        resolution?: '480p' | '720p';
      }>();
      const prompt = typeof form?.prompt === 'string' ? form.prompt.trim() : '';
      if (!prompt) err(422, 'Field required (prompt)');
      if (prompt.length > 4000) err(422, 'Le prompt est trop long (4000 caractères maximum).');

      const { IMAGINE_RATIOS } = await import('@/lib/images/styles');
      const aspectRatio =
        typeof form?.aspectRatio === 'string' && IMAGINE_RATIOS.includes(form.aspectRatio as never)
          ? form.aspectRatio
          : undefined;

      // Nouveaux contrôles du composeur : catégorie de média (image/vidéo/
      // GIF), modèle (Nelth-V2 vibes / Nelth-V3 nelthai), résolution vidéo.
      const kind: 'image' | 'video' | 'gif' =
        form?.kind === 'video' || form?.kind === 'gif' ? form.kind : 'image';
      const model: 'v2' | 'v3' | undefined =
        form?.model === 'v2' || form?.model === 'v3' ? form.model : undefined;
      const resolution: '480p' | '720p' | undefined =
        form?.resolution === '480p' || form?.resolution === '720p' ? form.resolution : undefined;

      let plan;
      try {
        plan = {
          prompt,
          style: typeof form?.style === 'string' ? form.style : undefined,
          aspectRatio,
          sourceImages: Array.isArray(form?.sourceImages) ? form.sourceImages : [],
          kind,
          // Le GIF n'existe qu'en V3 — le modèle est implicite et forcé.
          model: kind === 'gif' ? 'v3' : model,
          resolution: kind === 'video' ? resolution : undefined,
        };
        const items = await service.queueGenerateItems(ctx.user!, {
          ...plan,
          n: typeof form?.n === 'number' ? form.n : 1,
        });

        // Deferred worker — the response returns immediately; the UI polls
        // the rows while `after()` drives the real generation.
        const batch = service.buildBatchPlan(items, plan);
        after(() => service.runGenerationBatch(ctx.user!, batch));

        return ctx.json({ items });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, e instanceof Error ? e.message : 'Génération impossible.');
      }
    },
  },

  // ------------------- POST /edit -------------------
  {
    method: 'POST',
    path: 'edit',
    auth: 'user',
    handler: async (ctx) => {
      const service = await import('@/lib/images/service');
      try {
        await service.assertStudioPermission(ctx.user!);
      } catch (e) {
        err(403, e instanceof Error ? e.message : 'Édition d’images interdite.');
      }

      const form = await ctx.body<{ itemId?: string; prompt?: string }>();
      if (!form?.itemId || typeof form.itemId !== 'string') err(422, 'Field required (itemId)');
      const prompt = typeof form?.prompt === 'string' ? form.prompt.trim() : '';
      if (!prompt) err(422, 'Field required (prompt)');
      if (prompt.length > 4000) err(422, 'Les instructions sont trop longues (4000 caractères maximum).');

      let queued;
      try {
        queued = await service.queueEditItem(ctx.user!, form.itemId, prompt);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, e instanceof Error ? e.message : 'Édition impossible.');
      }

      after(() => service.runGenerationBatch(ctx.user!, [queued]));
      return ctx.json({ item: queued.item });
    },
  },

  // ------------------- POST /variations -------------------
  {
    method: 'POST',
    path: 'variations',
    auth: 'user',
    handler: async (ctx) => {
      const service = await import('@/lib/images/service');
      try {
        await service.assertStudioPermission(ctx.user!);
      } catch (e) {
        err(403, e instanceof Error ? e.message : 'Variations d’images interdites.');
      }

      const form = await ctx.body<{ itemId?: string }>();
      if (!form?.itemId || typeof form.itemId !== 'string') err(422, 'Field required (itemId)');

      let queued;
      try {
        queued = await service.queueVariationItem(ctx.user!, form.itemId);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, e instanceof Error ? e.message : 'Variation impossible.');
      }

      after(() => service.runGenerationBatch(ctx.user!, [queued]));
      return ctx.json({ item: queued.item });
    },
  },

  // ------------------- POST /upload -------------------
  {
    method: 'POST',
    path: 'upload',
    auth: 'user',
    handler: async (ctx) => {
      const service = await import('@/lib/images/service');
      let file: File | null = null;
      try {
        const form = await ctx.req.formData();
        const candidate = form.get('file');
        if (candidate instanceof File) file = candidate;
      } catch {
        err(400, 'Requête multipart invalide.');
      }
      if (!file) err(422, 'Field required (file)');
      if (!file.type.startsWith('image/')) {
        err(422, 'Seules les images sont acceptées (PNG, JPEG, WebP, GIF).');
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        err(413, 'Image trop volumineuse (10 Mo maximum).');
      }

      const bytes = Buffer.from(await file.arrayBuffer());
      const filename = (file.name || 'import').split(/[\\/]/).pop() ?? 'import';
      try {
        const item = await service.createUploadItem(ctx.user!, bytes, filename, file.type);
        return ctx.json(item);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, e instanceof Error ? e.message : 'Import impossible.');
      }
    },
  },

  // ------------------- PATCH /items/:id -------------------
  {
    method: 'PATCH',
    path: 'items/:id',
    auth: 'user',
    handler: async (ctx) => {
      const { patchItemForUser } = await import('@/lib/images/service');
      const form = await ctx.body<{ name?: string; favorite?: boolean }>();
      try {
        const item = await patchItemForUser(ctx.user!, ctx.params.id, form ?? {});
        if (!item) err(404, 'Image introuvable.');
        return ctx.json(item);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        err(400, e instanceof Error ? e.message : 'Mise à jour impossible.');
      }
    },
  },

  // ------------------- DELETE /items/:id -------------------
  {
    method: 'DELETE',
    path: 'items/:id',
    auth: 'user',
    handler: async (ctx) => {
      const { deleteItemForUser } = await import('@/lib/images/service');
      const removed = await deleteItemForUser(ctx.user!, ctx.params.id);
      if (!removed) err(404, 'Image introuvable.');
      return ctx.json({ status: true });
    },
  },
];
