'use client';

/**
 * Nelth-IA Images — inspiration gallery.
 *
 * Discovery grid of curated artworks (static, really AI-generated studio
 * assets) with categories. Card actions run REAL generations through the
 * active engine using the curated French prompt.
 */

import * as React from 'react';
import { Loader2, Sparkles, Wand2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { GALLERY_CATEGORIES, galleryByCategory } from '@/lib/images/gallery';
import { ratioValue } from '@/lib/images/styles';
import { StudioImg } from './ImagineShared';

interface InspirationGalleryProps {
  busy?: boolean;
  onUsePrompt: (prompt: string) => void;
  onGeneratePrompt: (prompt: string) => void;
}

export function InspirationGallery({ busy, onUsePrompt, onGeneratePrompt }: InspirationGalleryProps) {
  const [category, setCategory] = React.useState('all');
  const entries = React.useMemo(() => galleryByCategory(category), [category]);

  return (
    <section aria-label="Galerie d’inspiration" className="space-y-4">
      {/* Category filters — horizontally scrollable on mobile */}
      <div
        role="tablist"
        aria-label="Catégories d’inspiration"
        className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]"
      >
        {GALLERY_CATEGORIES.map((entry) => {
          const active = entry.id === category;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setCategory(entry.id)}
              className={
                'h-8 shrink-0 rounded-full border px-3 text-xs font-medium transition-colors ' +
                (active
                  ? 'border-emerald-600 bg-emerald-600 text-white'
                  : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-600')
              }
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      {/* Masonry-style grid */}
      <div className="columns-2 gap-3 sm:columns-3 xl:columns-4 [&>*]:mb-3">
        {entries.map((entry) => (
          <figure
            key={entry.id}
            className="group relative break-inside-avoid overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
          >
            <StudioImg
              src={entry.asset}
              alt={`${GALLERY_CATEGORIES.find((c) => c.id === entry.category)?.label ?? entry.category} — exemple d’inspiration`}
              loading="lazy"
              width={ratioValue(entry.ratio) >= 1 ? 800 : 600}
              style={{ aspectRatio: ratioValue(entry.ratio) }}
              className="w-full object-cover transition duration-300 group-hover:scale-[1.02]"
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent opacity-0 transition group-hover:opacity-100" />
            <figcaption className="absolute inset-x-0 bottom-0 flex translate-y-3 flex-col gap-2 p-3 opacity-0 transition duration-300 group-hover:translate-y-0 group-hover:opacity-100">
              <p className="line-clamp-2 text-[11px] leading-snug text-white/85">{entry.prompt}</p>
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => onGeneratePrompt(entry.prompt)}
                  className="h-7 gap-1 rounded-lg bg-white px-2.5 text-[11px] font-medium text-zinc-900 hover:bg-zinc-100 disabled:opacity-60"
                  aria-label={`Générer une image à partir du prompt « ${entry.prompt} »`}
                >
                  {busy ? (
                    <Loader2 className="size-3 animate-spin" aria-hidden />
                  ) : (
                    <Sparkles className="size-3" aria-hidden />
                  )}
                  Générer
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onUsePrompt(entry.prompt)}
                  className="h-7 gap-1 rounded-lg bg-white/15 px-2.5 text-[11px] font-medium text-white backdrop-blur hover:bg-white/25"
                  aria-label={`Utiliser le prompt « ${entry.prompt} »`}
                >
                  <Wand2 className="size-3" aria-hidden />
                  Utiliser le prompt
                </Button>
              </div>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
