'use client';

/**
 * Nelth-IA Images — shared presentation primitives.
 *
 * StudioImg: plain <img> wrapper (blob URLs + static gallery assets are not
 * served through the Next.js image optimizer) — keeps the no-img-element
 * lint exception in a single place.
 *
 * All visual tokens follow the original Open WebUI palette (gray surfaces on
 * the gray-50/gray-950 canvas — never zinc, never custom accents).
 */

import * as React from 'react';
import { Loader2 } from 'lucide-react';

import { authImageUrl, peekAuthImage } from '@/lib/images/client';
import type { ImagineItem, ImaginePhase } from '@/lib/images/types';
import { ratioValue } from '@/lib/images/styles';

export type StudioImgProps = React.ImgHTMLAttributes<HTMLImageElement> & {
  ref?: React.Ref<HTMLImageElement>;
};

export function StudioImg({ ref, alt, ...props }: StudioImgProps) {
  return <img ref={ref} alt={alt ?? ''} {...props} />;
}

/** Resolve an authenticated image URL into a cached blob URL. */
export function useAuthImage(path: string | null | undefined): string | null {
  const [url, setUrl] = React.useState<string | null>(() => (path ? peekAuthImage(path) : null));

  React.useEffect(() => {
    let cancelled = false;
    if (!path) {
      setUrl(null);
      return;
    }
    const cached = peekAuthImage(path);
    if (cached) {
      setUrl(cached);
      return;
    }
    void authImageUrl(path).then((resolved) => {
      if (!cancelled && resolved) setUrl(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return url;
}

/** Phase label shown on skeletons and the detail panel. */
export function phaseLabel(phase: ImaginePhase | null): string {
  switch (phase) {
    case 'sending':
      return 'Sending to engine';
    case 'generating':
      return 'Generating';
    case 'image':
      return 'Finalizing';
    default:
      return 'Preparing';
  }
}

/** Status label for completed/failed badges. */
export function statusLabel(item: ImagineItem): string | null {
  if (item.status === 'failed') return 'Failed';
  if (item.status === 'completed') return null;
  if (item.status === 'processing') return 'Processing';
  return 'Generating';
}

export function sourceLabel(source: ImagineItem['source']): string {
  switch (source) {
    case 'generate':
      return 'Generated';
    case 'edit':
      return 'Edited';
    case 'variation':
      return 'Variation';
    case 'upload':
      return 'Uploaded';
    default:
      return source;
  }
}

export function formatDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  return date.toLocaleString('en-US', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Completed-item thumbnail (authenticated blob URL + graceful placeholder). */
export function ItemThumb({
  item,
  className,
  imgClassName,
}: {
  item: ImagineItem;
  className?: string;
  imgClassName?: string;
}) {
  const url = useAuthImage(item.status === 'completed' ? item.url : null);
  const ratio = item.aspect_ratio ?? (item.width && item.height ? `${item.width}:${item.height}` : '1:1');
  return (
    <span
      className={'block overflow-hidden ' + (className ?? '')}
      style={{ aspectRatio: ratioValue(ratio) }}
    >
      {url ? (
        <StudioImg
          src={url}
          alt={item.prompt ?? item.name ?? 'Generated image'}
          loading="lazy"
          className={'size-full object-cover ' + (imgClassName ?? '')}
        />
      ) : (
        <span className="block size-full animate-pulse bg-gray-100 dark:bg-gray-800" aria-hidden />
      )}
    </span>
  );
}

/** Shimmering skeleton card shown while an item is generating. */
export function GenerationSkeleton({
  item,
  className,
}: {
  item: ImagineItem;
  className?: string;
}) {
  const label = phaseLabel(item.phase);
  return (
    <figure
      className={
        'group relative overflow-hidden rounded-xl border border-gray-100 bg-gray-100 dark:border-gray-850 dark:bg-gray-900 ' +
        (className ?? '')
      }
      aria-label={`Generating: ${item.prompt ?? 'no prompt'} — ${label}`}
    >
      <div className="animate-pulse flex h-full w-full items-center justify-center">
        <div className="flex flex-col items-center gap-2 p-6 text-gray-500 dark:text-gray-400">
          <Loader2 className="size-6 animate-spin" aria-hidden />
          <span className="text-xs font-medium">{label}</span>
        </div>
      </div>
      {item.prompt ? (
        <figcaption className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-3 pb-2 pt-6 text-[11px] text-white/90">
          {item.prompt}
        </figcaption>
      ) : null}
    </figure>
  );
}
