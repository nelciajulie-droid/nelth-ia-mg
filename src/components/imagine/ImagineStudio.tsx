'use client';

/**
 * Nelth-IA Images — studio orchestrator.
 *
 * Wires the header, the creation workspace, the active-generations strip,
 * the Inspiration/Library tabs and the immersive detail overlay. Server-side
 * records (ImageItem rows) are the single source of truth — the UI polls
 * while any item is generating/processing, which also gives refresh-recovery
 * for free (items survive navigation in the database).
 */

import * as React from 'react';
import {
  ArrowLeft,
  ChevronRight,
  Image as ImageIcon,
  Loader2,
  Plus,
  Settings2,
  Sparkles,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { IMAGINE_STYLES, imagineStyleById } from '@/lib/images/styles';
import type { ImagineCapabilities, ImagineItem } from '@/lib/images/types';
import {
  deleteItem,
  editImage,
  fetchCapabilities,
  fetchItems,
  generateImages,
  imagineUpload,
  patchItem,
  variationImage,
  type ImagineSessionUser,
} from '@/lib/images/client';
import { GenerationSkeleton, ItemThumb, sourceLabel } from './ImagineShared';
import { WorkspaceComposer, type ComposerSettings } from './WorkspaceComposer';
import { InspirationGallery } from './InspirationGallery';
import { LibraryView } from './LibraryView';
import { ImageDetailOverlay } from './ImageDetailOverlay';

const DEFAULTS_KEY = 'nelth.imagine.defaults';
const POLL_MS = 2000;

const DEFAULT_SETTINGS: ComposerSettings = { aspectRatio: '1:1', style: 'none', n: 1 };

function loadSettings(): ComposerSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(DEFAULTS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ComposerSettings>;
    return {
      aspectRatio: typeof parsed.aspectRatio === 'string' ? parsed.aspectRatio : '1:1',
      style: typeof parsed.style === 'string' ? parsed.style : 'none',
      n: typeof parsed.n === 'number' && parsed.n >= 1 && parsed.n <= 4 ? Math.round(parsed.n) : 1,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

interface ImagineStudioProps {
  user: ImagineSessionUser;
}

export function ImagineStudio({ user }: ImagineStudioProps) {
  const { toast } = useToast();

  const [capabilities, setCapabilities] = React.useState<ImagineCapabilities | null>(null);
  const [items, setItems] = React.useState<ImagineItem[]>([]);
  const [itemsLoading, setItemsLoading] = React.useState(true);
  const [tab, setTab] = React.useState<'inspiration' | 'library'>('inspiration');
  const [settings, setSettings] = React.useState<ComposerSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [busyReason, setBusyReason] = React.useState<string | null>(null);
  const composerRef = React.useRef<HTMLDivElement>(null);

  // ---- initial load ----
  React.useEffect(() => {
    setSettings(loadSettings());
    let cancelled = false;
    void (async () => {
      try {
        const [caps, list] = await Promise.all([
          fetchCapabilities(),
          fetchItems({ limit: 120 }),
        ]);
        if (cancelled) return;
        setCapabilities(caps);
        setItems(list.items);
        // Recovery: items still generating on a fresh page load keep polling.
      } catch (err) {
        if (!cancelled) {
          toast({
            title: 'Studio indisponible',
            description: err instanceof Error ? err.message : 'Erreur inconnue',
            variant: 'destructive',
          });
        }
      } finally {
        if (!cancelled) setItemsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast]);

  const activeItems = React.useMemo(
    () => items.filter((item) => item.status === 'generating' || item.status === 'processing'),
    [items]
  );
  const completedItems = React.useMemo(
    () => items.filter((item) => item.status !== 'generating' && item.status !== 'processing'),
    [items]
  );
  const detailItem = React.useMemo(
    () => items.find((item) => item.id === detailId) ?? null,
    [items, detailId]
  );

  // ---- polling while anything is in flight ----
  React.useEffect(() => {
    if (activeItems.length === 0) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const list = await fetchItems({ limit: 120 });
          if (!cancelled) setItems(list.items);
        } catch {
          /* transient poll failure — next tick retries */
        }
      })();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeItems.length > 0]);

  function applySettings(next: ComposerSettings) {
    setSettings(next);
    try {
      window.localStorage.setItem(DEFAULTS_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
  }

  function mergeItems(incoming: ImagineItem[]) {
    setItems((prev) => {
      const byId = new Map(prev.map((item) => [item.id, item]));
      for (const item of incoming) byId.set(item.id, item);
      return [...byId.values()].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    });
  }

  function failToast(action: string, err: unknown) {
    toast({
      title: action,
      description: err instanceof Error ? err.message : 'Erreur inconnue',
      variant: 'destructive',
    });
  }

  // ---- generation ----
  const handleGenerate = React.useCallback(
    async (
      prompt: string,
      attachments: Array<{ name: string; dataUrl: string }> = [],
      overrides: { style?: string; aspectRatio?: string; n?: number } = {}
    ) => {
      setSubmitting(true);
      try {
        const result = await generateImages({
          prompt,
          aspectRatio: overrides.aspectRatio ?? settings.aspectRatio,
          style: overrides.style ?? settings.style,
          n: overrides.n ?? settings.n,
          sourceImages: attachments.map((attachment) => ({
            url: attachment.dataUrl,
            name: attachment.name,
            type: 'image',
          })),
        });
        mergeItems(result.items);
        setTab('library');
      } catch (err) {
        failToast('Génération refusée', err);
      } finally {
        setSubmitting(false);
      }
    },
    [settings, toast]
  );

  const handleUploadFile = React.useCallback(
    async (file: File) => {
      try {
        const item = await imagineUpload(file);
        mergeItems([item]);
        toast({ title: 'Image importée', description: `${file.name} ajoutée à votre bibliothèque.` });
      } catch (err) {
        failToast('Import impossible', err);
      }
    },
    [toast]
  );

  // ---- item actions ----
  const handleToggleFavorite = React.useCallback(
    async (item: ImagineItem) => {
      // Optimistic flip, server reconciliation on next poll/list refresh.
      setItems((prev) =>
        prev.map((entry) => (entry.id === item.id ? { ...entry, favorite: !entry.favorite } : entry))
      );
      try {
        await patchItem(item.id, { favorite: !item.favorite });
      } catch (err) {
        failToast('Favori non enregistré', err);
        setItems((prev) => prev.map((entry) => (entry.id === item.id ? item : entry)));
      }
    },
    [toast]
  );

  const handleRename = React.useCallback(
    async (item: ImagineItem, name: string) => {
      setItems((prev) => prev.map((entry) => (entry.id === item.id ? { ...entry, name } : entry)));
      try {
        await patchItem(item.id, { name });
      } catch (err) {
        failToast('Renommage non enregistré', err);
      }
    },
    [toast]
  );

  const handleDelete = React.useCallback(
    async (item: ImagineItem) => {
      setItems((prev) => prev.filter((entry) => entry.id !== item.id));
      if (detailId === item.id) setDetailId(null);
      try {
        await deleteItem(item.id);
      } catch (err) {
        failToast('Suppression impossible', err);
        mergeItems([item]);
      }
    },
    [detailId, toast]
  );

  const handleEdit = React.useCallback(
    async (item: ImagineItem, prompt: string) => {
      setBusyReason('Édition en cours…');
      try {
        const result = await editImage({ itemId: item.id, prompt });
        mergeItems([result.item]);
        setDetailId(result.item.id);
      } catch (err) {
        failToast('Édition impossible', err);
      } finally {
        setBusyReason(null);
      }
    },
    [toast]
  );

  const handleVariation = React.useCallback(
    async (item: ImagineItem) => {
      setBusyReason('Variation en cours…');
      try {
        const result = await variationImage({ itemId: item.id });
        mergeItems([result.item]);
        setDetailId(result.item.id);
      } catch (err) {
        failToast('Variation impossible', err);
      } finally {
        setBusyReason(null);
      }
    },
    [toast]
  );

  const handleRegenerate = React.useCallback(
    async (item: ImagineItem) => {
      if (!item.prompt) return;
      await handleGenerate(item.prompt, [], {
        style: typeof item.meta?.style === 'string' ? (item.meta.style as string) : undefined,
        aspectRatio: item.aspect_ratio ?? undefined,
        n: 1,
      });
    },
    [handleGenerate]
  );

  const handleRetry = React.useCallback(
    async (item: ImagineItem) => {
      if (!item.prompt) return;
      await handleGenerate(item.prompt, [], {
        style: typeof item.meta?.style === 'string' ? (item.meta.style as string) : undefined,
        aspectRatio: item.aspect_ratio ?? undefined,
        n: 1,
      });
    },
    [handleGenerate]
  );

  const handleNavigate = React.useCallback(
    (delta: number) => {
      if (!detailId) return;
      const index = completedItems.findIndex((entry) => entry.id === detailId);
      if (index < 0) return;
      const next = completedItems[index + delta];
      if (next) setDetailId(next.id);
    },
    [completedItems, detailId]
  );

  function focusComposer() {
    composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.dispatchEvent(new CustomEvent('nelth:imagine:use-prompt', { detail: '' }));
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {/* Header */}
      <header className="shrink-0 border-b border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/90">
        <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-4 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 gap-1.5 rounded-lg text-zinc-600 dark:text-zinc-300"
            onClick={() => {
              window.location.href = '/';
            }}
            aria-label="Retour aux conversations"
          >
            <ArrowLeft className="size-4" aria-hidden />
            <span className="hidden sm:inline">Conversations</span>
          </Button>
          <div className="min-w-0">
            <h1 className="flex items-center gap-1.5 text-base font-semibold leading-tight">
              <ImageIcon className="size-4 text-emerald-600 dark:text-emerald-500" aria-hidden />
              Images
            </h1>
            <p className="hidden text-[11px] text-zinc-500 dark:text-zinc-400 sm:block">
              Créez, modifiez et explorez des images avec l’IA.
            </p>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {capabilities ? (
              <span className="hidden max-w-[210px] items-center gap-1 truncate rounded-full border border-zinc-200 px-2.5 py-1 text-[11px] text-zinc-500 dark:border-zinc-700 dark:text-zinc-400 lg:flex">
                <Sparkles className="size-3 shrink-0 text-emerald-600 dark:text-emerald-500" aria-hidden />
                {capabilities.engineLabel}
              </span>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 rounded-lg"
              onClick={() => setSettingsOpen(true)}
              aria-label="Paramètres du studio"
            >
              <Settings2 className="size-4" aria-hidden />
              <span className="hidden sm:inline">Paramètres</span>
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-9 gap-1.5 rounded-lg bg-emerald-600 font-medium text-white hover:bg-emerald-500"
              onClick={focusComposer}
            >
              <Plus className="size-4" aria-hidden />
              <span className="hidden sm:inline">Nouvelle image</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
        <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6">
          {/* Creation workspace */}
          <div ref={composerRef}>
            <WorkspaceComposer
              capabilities={capabilities}
              settings={settings}
              onSettingsChange={applySettings}
              busy={submitting}
              onGenerate={(prompt, attachments) => void handleGenerate(prompt, attachments)}
            />
          </div>

          {/* Active generations */}
          {activeItems.length > 0 ? (
            <section aria-label="Générations en cours" className="space-y-2">
              <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                <Loader2 className="size-3.5 animate-spin text-emerald-600 dark:text-emerald-500" aria-hidden />
                Générations en cours ({activeItems.length})
              </h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                {activeItems
                  .slice()
                  .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
                  .map((item) => (
                    <GenerationSkeleton key={item.id} item={item} className="w-full" />
                  ))}
              </div>
            </section>
          ) : null}

          {/* Tabs */}
          <div className="flex items-center gap-2">
            <div
              role="tablist"
              aria-label="Sections du studio"
              className="flex gap-1 rounded-xl border border-zinc-200 bg-white p-1 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <StudioTab active={tab === 'inspiration'} onClick={() => setTab('inspiration')} label="Inspiration" />
              <StudioTab active={tab === 'library'} onClick={() => setTab('library')} label="Ma bibliothèque">
                <span className="ml-1 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  {completedItems.length}
                </span>
              </StudioTab>
            </div>
          </div>

          {tab === 'inspiration' ? (
            <InspirationGallery
              busy={submitting}
              onUsePrompt={(prompt) => {
                window.dispatchEvent(new CustomEvent('nelth:imagine:use-prompt', { detail: prompt }));
              }}
              onGeneratePrompt={(prompt) => void handleGenerate(prompt, [])}
            />
          ) : (
            <LibraryView
              items={items}
              loading={itemsLoading}
              busy={submitting}
              onOpen={(item) => setDetailId(item.id)}
              onToggleFavorite={(item) => void handleToggleFavorite(item)}
              onDelete={(item) => void handleDelete(item)}
              onRetry={(item) => void handleRetry(item)}
              onUploadFile={(file) => void handleUploadFile(file)}
            />
          )}

          {/* Recently generated teaser under the composer on first visit */}
          {tab === 'inspiration' && completedItems.length > 0 ? (
            <section aria-label="Générées récemment" className="space-y-2">
              <button
                type="button"
                onClick={() => setTab('library')}
                className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 transition hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              >
                Générées récemment
                <ChevronRight className="size-3.5" aria-hidden />
              </button>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                {completedItems.slice(0, 4).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setDetailId(item.id)}
                    className="group relative overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
                    aria-label={`Ouvrir l’image ${item.name ?? item.prompt ?? ''}`}
                  >
                    <ItemThumb item={item} className="w-full" imgClassName="transition duration-300 group-hover:scale-[1.03]" />
                    <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-2 pb-1.5 pt-5 text-[11px] text-white/90">
                      {item.name ?? item.prompt ?? sourceLabel(item.source)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>

      {/* Settings dialog */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Paramètres du studio</DialogTitle>
            <DialogDescription>
              Vos préférences par défaut pour les nouvelles générations.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="imagine-default-ratio" className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                Format par défaut
              </label>
              <Select
                value={settings.aspectRatio}
                onValueChange={(value) => applySettings({ ...settings, aspectRatio: value })}
              >
                <SelectTrigger id="imagine-default-ratio" className="h-9 rounded-lg" />
                <SelectContent>
                  {['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'].map((ratio) => (
                    <SelectItem key={ratio} value={ratio}>
                      {ratio}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="imagine-default-style" className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                Style par défaut
              </label>
              <Select
                value={settings.style}
                onValueChange={(value) => applySettings({ ...settings, style: value })}
              >
                <SelectTrigger id="imagine-default-style" className="h-9 rounded-lg" />
                <SelectContent>
                  {IMAGINE_STYLES.map((style) => (
                    <SelectItem key={style.id} value={style.id}>
                      {style.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                Style appliqué : {imagineStyleById(settings.style)?.label ?? '—'}
              </p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="imagine-default-count" className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                Nombre d’images par défaut
              </label>
              <Select
                value={String(settings.n)}
                onValueChange={(value) => applySettings({ ...settings, n: Number(value) })}
              >
                <SelectTrigger id="imagine-default-count" className="h-9 rounded-lg" />
                <SelectContent>
                  {Array.from({ length: capabilities?.maxCount ?? 4 }, (_, i) => i + 1).map((count) => (
                    <SelectItem key={count} value={String(count)}>
                      {count}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
              Moteur actif : {capabilities?.engineLabel ?? '…'} — la configuration des moteurs
              reste gérée par l’administrateur (Espace de travail → Images).
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Detail overlay */}
      <ImageDetailOverlay
        item={detailItem}
        siblings={completedItems}
        busyReason={busyReason}
        onClose={() => setDetailId(null)}
        onNavigate={handleNavigate}
        onToggleFavorite={(item) => void handleToggleFavorite(item)}
        onDelete={(item) => void handleDelete(item)}
        onRename={(item, name) => void handleRename(item, name)}
        onEdit={(item, prompt) => void handleEdit(item, prompt)}
        onVariation={(item) => void handleVariation(item)}
        onRegenerate={(item) => void handleRegenerate(item)}
      />
    </div>
  );
}

function StudioTab({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'flex h-8 items-center gap-1 rounded-lg px-3 text-xs font-medium transition-colors',
        active
          ? 'bg-zinc-100 text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-white'
          : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
      )}
    >
      {label}
      {children}
    </button>
  );
}
