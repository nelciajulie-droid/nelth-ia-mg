'use client';

/**
 * Nelth-IA Images — personal library.
 *
 * The user's persisted items: filters (type, favorites, search, date), the
 * upload button (real files pipeline), and a responsive grid where active
 * items keep their live generation skeleton until the poller sees them land.
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

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  { id: 'all', label: 'Toutes' },
  { id: 'recent', label: 'Récentes (7 j)' },
  { id: 'favorite', label: 'Favoris' },
  { id: 'generate', label: 'Générées' },
  { id: 'edit', label: 'Modifiées' },
  { id: 'variation', label: 'Variations' },
  { id: 'upload', label: 'Importées' },
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
    <section aria-label="Ma bibliothèque d’images" className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Rechercher un prompt, un nom…"
            aria-label="Rechercher dans ma bibliothèque"
            className="h-9 rounded-lg pl-8 text-sm"
          />
        </div>
        <Select value={filter} onValueChange={(value) => setFilter(value as LibraryFilter)}>
          <SelectTrigger className="h-9 w-[150px] rounded-lg text-sm" aria-label="Filtrer la bibliothèque">
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
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto h-9 gap-1.5 rounded-lg"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="size-3.5" aria-hidden />
          Importer
        </Button>
      </div>

      {/* Grid */}
      {loading && items.length === 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <div
              key={i}
              className="aspect-square animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-900"
              aria-hidden
            />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 p-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          {items.length === 0
            ? 'Aucune image pour l’instant — décrivez votre première idée dans l’espace de création.'
            : 'Aucun résultat pour ce filtre.'}
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
          {item.error ?? 'La génération a échoué.'}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1 rounded-lg text-[11px]"
          onClick={onRetry}
        >
          <RotateCcw className="size-3" aria-hidden />
          Réessayer
        </Button>
      </figure>
    );
  }

  return (
    <figure className="group relative overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900">
      <button
        type="button"
        onClick={onOpen}
        className="block w-full"
        aria-label={`Ouvrir l’image : ${item.name ?? item.prompt ?? 'sans titre'}`}
      >
        {url ? (
          <StudioImg
            src={url}
            alt={item.prompt ?? item.name ?? 'Image générée'}
            loading="lazy"
            style={{ aspectRatio: aspect }}
            className="w-full object-cover transition duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div
            className="w-full animate-pulse bg-zinc-200 dark:bg-zinc-800"
            style={{ aspectRatio: aspect }}
            aria-hidden
          />
        )}
      </button>
      {item.favorite ? (
        <Heart
          className="absolute left-2 top-2 size-4 fill-red-500 text-red-500 drop-shadow"
          aria-label="Favori"
        />
      ) : null}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 transition group-hover:opacity-100" />
      <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 p-2 opacity-0 transition group-hover:pointer-events-auto group-hover:opacity-100">
        <p className="line-clamp-1 flex-1 text-[11px] text-white/90">
          {item.name ?? item.prompt ?? formatDate(item.created_at)}
        </p>
        <div className="flex gap-1">
          <IconOverlayButton
            label={item.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
            onClick={onToggleFavorite}
          >
            <Heart className={cn('size-3.5', item.favorite && 'fill-red-500 text-red-500')} aria-hidden />
          </IconOverlayButton>
          <IconOverlayButton label="Supprimer l’image" danger onClick={onDelete}>
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
