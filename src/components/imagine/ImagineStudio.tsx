'use client';

/**
 * Nelth-IA Images — studio orchestrator.
 *
 * Follows the ORIGINAL Open WebUI interface system (inspected from the live
 * SPA DOM — every class below replicates the host app):
 *
 *   • the 42px icon rail on the left (same wrappers, size-8 links, 30px
 *     hover tiles, size-4 Lucide icons — PanelLeft, SquarePen, Search,
 *     NotebookText, PanelsTopLeft, Image) ;
 *   • the Workspace-style top navigation: blur-backed tab strip with
 *     counts (Inspiration / My Library) + right-side actions ;
 *   • the gray canvas (bg-gray-50 dark:bg-gray-950) and the black/white
 *     primary accent (bg-black dark:bg-white) used by the SPA buttons.
 *
 * Server-side records (ImageItem rows) remain the single source of truth —
 * the UI polls while any item is generating/processing, which also gives
 * refresh-recovery for free (items survive navigation in the database).
 */

import * as React from 'react';
import {
  ChevronLeft,
  Image as ImageIcon,
  Loader2,
  NotebookText,
  PanelLeft,
  PanelsTopLeft,
  Plus,
  Search as SearchIcon,
  Settings2,
  SquarePen,
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

// ---------------------------------------------------------------------------
// Icon rail — exact replica of the SPA sidebar rail (#sidebar)
// ---------------------------------------------------------------------------

const RAIL_TILE =
  'self-center flex size-[calc(30px*var(--app-text-scale,1))] items-center justify-center rounded-lg transition group-hover:bg-gray-100 dark:group-hover:bg-gray-900';

function RailLink({
  href,
  label,
  icon,
  current,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
  current?: boolean;
}) {
  return (
    <a
      href={href}
      aria-label={label}
      title={label}
      aria-current={current ? 'page' : undefined}
      draggable={false}
      className="cursor-pointer flex size-8 items-center justify-center transition group"
    >
      <div className={RAIL_TILE}>{icon}</div>
    </a>
  );
}

/** The 42px collapsed-icon rail — same structure as the SPA's #sidebar. */
function StudioRail({ user }: { user: ImagineSessionUser }) {
  const initials = user.name
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <nav
      aria-label="Chat history"
      className="hidden w-[calc(42px*var(--app-text-scale,1))] shrink-0 flex-col justify-between py-2 md:flex"
    >
      <div className="flex flex-col flex-1">
        {/* Top slot — the SPA's rail toggle, here: back to the app */}
        <div className="pb-1">
          <a
            href="/"
            aria-label="Back to Chats"
            title="Back to Chats"
            draggable={false}
            className="flex size-8.5 items-center justify-center transition group"
          >
            <div className={cn(RAIL_TILE, 'relative')}>
              <PanelLeft className="size-4" aria-hidden />
            </div>
          </a>
        </div>

        {/* Nav items — each in its own wrapper, stacked vertically */}
        <div>
          <div>
            <div className="flex">
              <RailLink href="/" label="New Chat" icon={<SquarePen className="size-4" aria-hidden />} />
            </div>
          </div>
          <div>
            <div className="flex">
              <a
                href="/"
                aria-label="Search"
                title="Search"
                draggable={false}
                className="cursor-pointer flex size-8 items-center justify-center transition group"
              >
                <div className={RAIL_TILE}>
                  <SearchIcon className="size-4" aria-hidden />
                </div>
              </a>
            </div>
          </div>
          <div>
            <div className="flex">
              <RailLink href="/notes" label="Notes" icon={<NotebookText className="size-4" aria-hidden />} />
            </div>
          </div>
          <div>
            <div className="flex">
              <RailLink
                href="/workspace"
                label="Workspace"
                icon={<PanelsTopLeft className="size-4" aria-hidden />}
              />
            </div>
          </div>
          <div data-imagine-studio="1">
            <div className="flex">
              <RailLink
                href="/images"
                label="Imagine Studio"
                icon={<ImageIcon className="size-4" aria-hidden />}
                current
              />
            </div>
          </div>
        </div>
      </div>

      {/* Bottom — user avatar, same tile styling */}
      <div>
        <div className="flex items-center justify-center">
          <a
            href="/"
            aria-label="Back to Chats"
            title="Back to Chats"
            draggable={false}
            className="flex size-8.5 items-center justify-center transition group"
          >
            <div className={RAIL_TILE}>
              {user.profile_image_url ? (
                <img
                  src={user.profile_image_url}
                  alt={user.name}
                  className="size-5.5 rounded-full object-cover"
                />
              ) : (
                <span className="flex size-5.5 items-center justify-center rounded-full bg-gray-200 text-[9px] font-semibold text-gray-600 dark:bg-gray-700 dark:text-gray-200">
                  {initials || 'U'}
                </span>
              )}
            </div>
          </a>
        </div>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Workspace-style tab (same classes as the SPA Models/Knowledge tabs)
// ---------------------------------------------------------------------------

function StudioTab({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'min-w-fit px-1 text-sm inline-flex items-center gap-1 transition select-none',
        active
          ? 'text-gray-900 dark:text-gray-100'
          : 'text-gray-300 dark:text-gray-600 hover:text-gray-700 dark:hover:text-white'
      )}
    >
      <span>{label}</span>
      {typeof count === 'number' ? <span className="text-sm opacity-60 tabular-nums">{count}</span> : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Studio
// ---------------------------------------------------------------------------

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
            title: 'Studio unavailable',
            description: err instanceof Error ? err.message : 'Unknown error',
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
      description: err instanceof Error ? err.message : 'Unknown error',
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
        failToast('Generation failed', err);
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
        toast({ title: 'Image imported', description: `${file.name} added to your library.` });
      } catch (err) {
        failToast('Import failed', err);
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
        failToast('Favorite not saved', err);
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
        failToast('Rename not saved', err);
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
        failToast('Delete failed', err);
        mergeItems([item]);
      }
    },
    [detailId, toast]
  );

  const handleEdit = React.useCallback(
    async (item: ImagineItem, prompt: string) => {
      setBusyReason('Editing…');
      try {
        const result = await editImage({ itemId: item.id, prompt });
        mergeItems([result.item]);
        setDetailId(result.item.id);
      } catch (err) {
        failToast('Edit failed', err);
      } finally {
        setBusyReason(null);
      }
    },
    [toast]
  );

  const handleVariation = React.useCallback(
    async (item: ImagineItem) => {
      setBusyReason('Creating variation…');
      try {
        const result = await variationImage({ itemId: item.id });
        mergeItems([result.item]);
        setDetailId(result.item.id);
      } catch (err) {
        failToast('Variation failed', err);
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
    <div className="flex h-dvh max-h-[100dvh] w-full overflow-hidden bg-gray-50 text-gray-700 dark:bg-gray-950 dark:text-gray-100">
      {/* Icon rail — replica of the SPA sidebar */}
      <StudioRail user={user} />

      {/* Main — same shell as the SPA's workspace pages */}
      <main className="flex h-screen max-h-[100dvh] min-w-0 flex-1 flex-col">
        {/* Top navigation — Workspace-style tab strip + actions */}
        <nav
          className="z-30 shrink-0 select-none border-b border-gray-100/60 bg-gray-50/95 px-2.5 pb-1 pt-2 backdrop-blur-xl dark:border-gray-850/60 dark:bg-gray-950/95"
          aria-label="Imagine Studio"
        >
          <div className="flex items-center gap-0.5 md:gap-1">
            {/* Mobile back affordance (the rail is desktop-only, like the SPA) */}
            <a
              href="/"
              aria-label="Back to Chats"
              draggable={false}
              className="mr-1 flex size-8 items-center justify-center rounded-full text-gray-600 transition hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800 md:hidden"
            >
              <ChevronLeft className="size-4" aria-hidden />
            </a>

            <h1 className="sr-only">Imagine Studio</h1>

            <div className="flex w-full min-w-0 items-center">
              <div className="flex min-w-0 w-fit items-center gap-0.5 overflow-x-auto bg-transparent py-1 text-center text-sm font-normal [scrollbar-width:none] md:gap-1">
                <StudioTab active={tab === 'inspiration'} onClick={() => setTab('inspiration')} label="Inspiration" />
                <StudioTab
                  active={tab === 'library'}
                  onClick={() => setTab('library')}
                  label="My Library"
                  count={completedItems.length}
                />
              </div>

              <div className="ml-auto flex shrink-0 items-center gap-1">
                {capabilities ? (
                  <span className="hidden max-w-[210px] items-center gap-1 truncate rounded-lg bg-gray-50 px-2.5 py-1 text-xs text-gray-600 ring-1 ring-gray-200 dark:bg-gray-850 dark:text-gray-100 dark:ring-gray-850 lg:flex">
                    <ImageIcon className="size-3 shrink-0 opacity-60" aria-hidden />
                    {capabilities.engineLabel}
                  </span>
                ) : null}
                <button
                  type="button"
                  aria-label="Studio settings"
                  onClick={() => setSettingsOpen(true)}
                  className="flex size-[1.875rem] items-center justify-center rounded-full bg-transparent text-gray-700 transition hover:bg-gray-100 dark:text-white dark:hover:bg-gray-800"
                >
                  <Settings2 className="size-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={focusComposer}
                  className="flex h-7 items-center gap-1.5 rounded-full bg-black px-3 text-xs font-medium text-white transition hover:bg-gray-900 dark:bg-white dark:text-black dark:hover:bg-gray-100"
                >
                  <Plus className="size-3.5" aria-hidden />
                  <span className="hidden sm:inline">New image</span>
                </button>
              </div>
            </div>
          </div>
        </nav>

        {/* Scrollable content — workspace container pattern */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-8 pt-3 [scrollbar-width:thin] md:px-6">
          <div className="mx-auto w-full max-w-6xl space-y-6">
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
              <section aria-label="Images in progress" className="space-y-2">
                <h2 className="flex items-center gap-2 text-[0.6875rem] font-normal text-gray-400 dark:text-gray-600">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  Generating ({activeItems.length})
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
              <section aria-label="Recently generated" className="space-y-2">
                <button
                  type="button"
                  onClick={() => setTab('library')}
                  className="flex items-center gap-1 text-[0.6875rem] font-normal text-gray-400 transition hover:text-gray-700 dark:text-gray-600 dark:hover:text-gray-200"
                >
                  Recently generated
                  <span className="opacity-60" aria-hidden>
                    →
                  </span>
                </button>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                  {completedItems.slice(0, 4).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setDetailId(item.id)}
                      className="group relative overflow-hidden rounded-xl border border-gray-100 bg-white dark:border-gray-850 dark:bg-gray-900"
                      aria-label={`Open image ${item.name ?? item.prompt ?? ''}`}
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
      </main>

      {/* Settings dialog */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Studio settings</DialogTitle>
            <DialogDescription>Your defaults for new generations.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="imagine-default-ratio" className="text-xs font-medium text-gray-600 dark:text-gray-300">
                Default ratio
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
              <label htmlFor="imagine-default-style" className="text-xs font-medium text-gray-600 dark:text-gray-300">
                Default style
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
              <p className="text-[11px] text-gray-500 dark:text-gray-400">
                Applied style: {imagineStyleById(settings.style)?.label ?? '—'}
              </p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="imagine-default-count" className="text-xs font-medium text-gray-600 dark:text-gray-300">
                Default image count
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
            <p className="text-[11px] leading-snug text-gray-500 dark:text-gray-400">
              Active engine: {capabilities?.engineLabel ?? '…'} — engine configuration stays with the
              administrator (Workspace → Images).
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
