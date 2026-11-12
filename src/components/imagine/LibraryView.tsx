'use client';

/**
 * Nelth-IA Images — personal library.
 *
 * The user's persisted items: filters (type, favorites, search, date), the
 * upload button (real files pipeline), and a responsive grid where active
 * items keep their live generation skeleton until the poller sees them land.
 * Visual system: the original SPA palette (gray surfaces, black/white
 * accent, workspace-style chips and inputs).
 */

import * as React from 'react';
import {
  AlertTriangle,
  Heart,
  Loader2,
  RotateCcw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { ratioValue } from '@/lib/images/styles';
import type { ImagineItem } from '@/lib/images/types';
import { formatDate, GenerationSkeleton, StudioImg, useAuthImage } from './ImagineShared';

export type LibraryFilter = 'all' | 'generate' | 'edit' | 'variation' | 'upload' | 'favorite' | 'recent';

interface LibraryViewProps {
  items: ImagineItem[];
  loading?: boolean;
  busy?: boolean;
  onOpen: (item: ImagineItem) => void;
  onToggleFavorite: (item: ImagineItem) => void;
  onDelete: (item: ImagineItem) => void;
  onRetry: (item: ImagineItem) => void;
  onUploadFile: (file: File) => void;
}

const FILTERS: Array<{ id: LibraryFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'recent', label: 'Recent (7d)' },
  { id: 'favorite', label: 'Favorites' },
  { id: 'generate', label: 'Generated' },
  { id: 'edit', label: 'Edited' },
  { id: 'variation', label: 'Variations' },
  { id: 'upload', label: 'Uploaded' },
];

export function LibraryView({
  items,
  loading,
  busy,
  onOpen,
  onToggleFavorite,
  onDelete,
  onRetry,
  onUploadFile,
}: LibraryViewProps) {
  const [filter, setFilter] = React.useState<LibraryFilter>('all');
  const [query, setQuery] = React.useState('');
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const visible = React.useMemo(() => {
    let list = [...items];
    if (filter === 'favorite') list = list.filter((item) => item.favorite);
    if (filter === 'recent') {
      const cutoff = (Date.now() - 7 * 86400_000) / 1000;
      list = list.filter((item) => (item.created_at ?? 0) >= cutoff);
    } else if (filter !== 'all') {
      list = list.filter((item) => item.source === filter);
    }
    const needle = query.trim().toLowerCase();
    if (needle) {
      list = list.filter(
        (item) =>
          (item.prompt ?? '').toLowerCase().includes(needle) ||
          (item.name ?? '').toLowerCase().includes(needle)
      );
    }
    return list;
  }, [items, filter, query]);

  return (
    <section aria-label="My image library" className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-gray-400"
            aria-hidden
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search prompts, names…"
            aria-label="Search my library"
            className="h-9 w-full rounded-lg bg-white pl-8 pr-3 text-sm text-gray-900 outline-none ring-1 ring-gray-200 transition placeholder:text-gray-400 focus:ring-gray-400 dark:bg-gray-900 dark:text-gray-100 dark:ring-gray-850 dark:focus:ring-gray-600"
          />
        </div>
        <Select value={filter} onValueChange={(value) => setFilter(value as LibraryFilter)}>
          <SelectTrigger className="h-9 w-[150px] rounded-lg text-sm" aria-label="Filter library">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTERS.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onUploadFile(file);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
          className="ml-auto flex h-7 items-center gap-1.5 overflow-hidden rounded-lg bg-gray-50 px-2.5 text-xs text-gray-900 ring-1 ring-gray-200 transition hover:bg-gray-100 disabled:opacity-50 dark:bg-gray-850 dark:text-gray-100 dark:ring-gray-850 dark:hover:bg-gray-800"
        >
          <Upload className="size-3.5" aria-hidden />
          Upload
        </button>
      </div>

      {/* Grid */}
      {loading && items.length === 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <div
              key={i}
              className="aspect-square animate-pulse rounded-xl bg-gray-100 dark:bg-gray-900"
              aria-hidden
            />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 p-10 text-center text-sm text-gray-500 dark:border-gray-800 dark:text-gray-400">
          {items.length === 0
            ? 'No images yet — describe your first idea in the creation workspace.'
            : 'No results for this filter.'}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {visible.map((item) => (
            <LibraryCard
              key={item.id}
              item={item}
              onOpen={() => onOpen(item)}
              onToggleFavorite={() => onToggleFavorite(item)}
              onDelete={() => onDelete(item)}
              onRetry={() => onRetry(item)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function LibraryCard({
  item,
  onOpen,
  onToggleFavorite,
  onDelete,
  onRetry,
}: {
  item: ImagineItem;
  onOpen: () => void;
  onToggleFavorite: () => void;
  onDelete: () => void;
  onRetry: () => void;
}) {
  const url = useAuthImage(item.status === 'completed' ? item.url : null);
  const ratio = item.aspect_ratio ?? (item.width && item.height ? `${item.width}:${item.height}` : null);
  const aspect = ratio ? ratioValue(ratio) : 1;

  if (item.status === 'generating' || item.status === 'processing') {
    return <GenerationSkeleton item={item} className="w-full" />;
  }

  if (item.status === 'failed') {
    return (
      <figure className="flex aspect-square flex-col items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50/60 p-3 text-center dark:border-red-900/60 dark:bg-red-950/30">
        <AlertTriangle className="size-5 text-red-500" aria-hidden />
        <p className="line-clamp-3 text-[11px] leading-snug text-red-700 dark:text-red-300">
          {item.error ?? 'Generation failed.'}
        </p>
        <button
          type="button"
          className="flex h-7 items-center gap-1 rounded-lg bg-gray-50 px-2.5 text-[11px] text-gray-900 ring-1 ring-gray-200 transition hover:bg-gray-100 dark:bg-gray-850 dark:text-gray-100 dark:ring-gray-850 dark:hover:bg-gray-800"
          onClick={onRetry}
        >
          <RotateCcw className="size-3" aria-hidden />
          Retry
        </button>
      </figure>
    );
  }

  return (
    <figure className="group relative overflow-hidden rounded-xl border border-gray-100 bg-white dark:border-gray-850 dark:bg-gray-900">
      <button
        type="button"
        onClick={onOpen}
        className="block w-full"
        aria-label={`Open image: ${item.name ?? item.prompt ?? 'untitled'}`}
      >
        {url ? (
          <StudioImg
            src={url}
            alt={item.prompt ?? item.name ?? 'Generated image'}
            loading="lazy"
            style={{ aspectRatio: aspect }}
            className="w-full object-cover transition duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div
            className="w-full animate-pulse bg-gray-100 dark:bg-gray-800"
            style={{ aspectRatio: aspect }}
            aria-hidden
          />
        )}
      </button>
      {item.favorite ? (
        <Heart
          className="absolute left-2 top-2 size-4 fill-red-500 text-red-500 drop-shadow"
          aria-label="Favorite"
        />
      ) : null}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 transition group-hover:opacity-100" />
      <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 p-2 opacity-0 transition group-hover:pointer-events-auto group-hover:opacity-100">
        <p className="line-clamp-1 flex-1 text-[11px] text-white/90">
          {item.name ?? item.prompt ?? formatDate(item.created_at)}
        </p>
        <div className="flex gap-1">
          <IconOverlayButton
            label={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
            onClick={onToggleFavorite}
          >
            <Heart className={cn('size-3.5', item.favorite && 'fill-red-500 text-red-500')} aria-hidden />
          </IconOverlayButton>
          <IconOverlayButton label="Delete image" danger onClick={onDelete}>
            <Trash2 className="size-3.5" aria-hidden />
          </IconOverlayButton>
        </div>
      </figcaption>
    </figure>
  );
}

function IconOverlayButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={
        'rounded-full bg-black/60 p-1.5 text-white backdrop-blur transition hover:bg-black/80 ' +
        (danger ? 'hover:text-red-300' : '')
      }
    >
      {children}
    </button>
  );
}
