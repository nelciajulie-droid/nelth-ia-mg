'use client';

/**
 * Nelth-IA Images — inspiration gallery.
 *
 * Discovery grid of curated artworks (static, really AI-generated studio
 * assets) with categories. Visual system: the original SPA palette (gray
 * cards on the gray-50 canvas, black/white accent chips). Card actions run
 * REAL generations through the active engine using the curated prompt.
 */

import * as React from 'react';
import { Loader2, Sparkles, Wand2 } from 'lucide-react';

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
    <section aria-label="Inspiration gallery" className="space-y-4">
      {/* Category filters — horizontally scrollable on mobile */}
      <div
        role="tablist"
        aria-label="Inspiration categories"
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
                'flex h-7 shrink-0 items-center rounded-full px-3 text-xs font-medium transition-colors ' +
                (active
                  ? 'bg-black text-white dark:bg-white dark:text-black'
                  : 'bg-gray-50 text-gray-900 ring-1 ring-gray-200 hover:bg-gray-100 dark:bg-gray-850 dark:text-gray-100 dark:ring-gray-850 dark:hover:bg-gray-800')
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
            className="group relative break-inside-avoid overflow-hidden rounded-xl border border-gray-100 bg-white dark:border-gray-850 dark:bg-gray-900"
          >
            <StudioImg
              src={entry.asset}
              alt={`${GALLERY_CATEGORIES.find((c) => c.id === entry.category)?.label ?? entry.category} — inspiration example`}
              loading="lazy"
              width={ratioValue(entry.ratio) >= 1 ? 800 : 600}
              style={{ aspectRatio: ratioValue(entry.ratio) }}
              className="w-full object-cover transition duration-300 group-hover:scale-[1.02]"
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent opacity-0 transition group-hover:opacity-100" />
            <figcaption className="absolute inset-x-0 bottom-0 flex translate-y-3 flex-col gap-2 p-3 opacity-0 transition duration-300 group-hover:translate-y-0 group-hover:opacity-100">
              <p className="line-clamp-2 text-[11px] leading-snug text-white/85">{entry.prompt}</p>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onGeneratePrompt(entry.prompt)}
                  className="flex h-7 items-center gap-1 rounded-full bg-white px-2.5 text-[11px] font-medium text-black transition hover:bg-gray-200 disabled:opacity-60"
                  aria-label={`Generate an image from the prompt “${entry.prompt}”`}
                >
                  {busy ? (
                    <Loader2 className="size-3 animate-spin" aria-hidden />
                  ) : (
                    <Sparkles className="size-3" aria-hidden />
                  )}
                  Generate
                </button>
                <button
                  type="button"
                  onClick={() => onUsePrompt(entry.prompt)}
                  className="flex h-7 items-center gap-1 rounded-full bg-white/15 px-2.5 text-[11px] font-medium text-white backdrop-blur transition hover:bg-white/25"
                  aria-label={`Use the prompt “${entry.prompt}”`}
                >
                  <Wand2 className="size-3" aria-hidden />
                  Use prompt
                </button>
              </div>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
